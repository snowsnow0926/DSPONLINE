use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use anyhow::{Context, anyhow, bail};
use serde_json::{Map, Number, Value, json};

use crate::catalog::{BuildingDefinition, RecipeDefinition};
use crate::deterministic_runtime::{
    DeterministicRuntime, PARALLEL_MIN_ITEMS, PartitionedPrepareDiagnostics,
    runtime as deterministic_runtime,
};
use crate::factory_writer_events::{
    FactoryExecutionDiagnostics, FactoryExecutionDiagnosticsBuilder, FactoryScanStage,
    FactoryWriterDomain, FactoryWriterEvents, SealedFactoryWriterEvents,
};
use crate::state::CoreState;

const EPSILON: f64 = 0.0001;
const MIN_BUILDING_BUFFER_LIMIT: f64 = 1_000.0;
const DEFAULT_BUILDING_BUFFER_LIMIT: f64 = 1_000_000.0;
const MAX_BUILDING_BUFFER_LIMIT: f64 = 100_000_000.0;
const GRID_IDS: [&str; 3] = ["grid-a", "grid-b", "grid-c"];
const PLANET_METRIC_ACTIVE_DENSE_NUMERATOR: usize = 3;
const PLANET_METRIC_ACTIVE_DENSE_DENOMINATOR: usize = 4;
const PLANET_METRIC_BTREE_FIRST_NODE_BYTES: u64 = 256;
const PLANET_METRIC_BTREE_WORDS_PER_ENTRY: u64 = 6;
const POWER_PROBE_ACTIVE_DENSE_NUMERATOR: usize = 3;
const POWER_PROBE_ACTIVE_DENSE_DENOMINATOR: usize = 4;

fn collect_indexed_power_probes_with_runtime<T, R, F>(
    runtime: &DeterministicRuntime,
    values: &[T],
    probe: F,
) -> Vec<R>
where
    T: Sync,
    R: Send,
    F: Fn(&T) -> R + Send + Sync,
{
    runtime.indexed_map(values, |_, value| probe(value))
}

fn update_indexed_factory_probes_with_runtime<T, F>(
    runtime: &DeterministicRuntime,
    values: &mut [T],
    update: F,
) where
    T: Send,
    F: Fn(&mut T) + Send + Sync,
{
    runtime.indexed_for_each_mut(values, |_, value| update(value));
}

#[derive(Debug, Clone, Copy, Default)]
struct PlanetProfile {
    wind_multiplier: f64,
    solar_power_multiplier: f64,
    geothermal_multiplier: f64,
    mining_multiplier: f64,
    production_speed_multiplier: f64,
    specialization: &'static str,
    ocean_type: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct PlanetMetricProbe {
    production_rate: f64,
    reserve_primary: f64,
    reserve_secondary: f64,
    planet_index: u32,
    reserve_kind: PlanetReserveKind,
}

impl Default for PlanetMetricProbe {
    fn default() -> Self {
        Self {
            production_rate: 0.0,
            reserve_primary: 0.0,
            reserve_secondary: 0.0,
            planet_index: u32::MAX,
            reserve_kind: PlanetReserveKind::None,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
enum PlanetReserveKind {
    #[default]
    None,
    StoredEnergy,
    Fuel,
}

/// Session-only probe cache for the fields used by `planetMetrics`.
///
/// The expensive JSON/catalog probe is O(active/changed) after the cold pass.
/// The compact probe values are still replayed in persisted entity order on
/// every step because changing that IEEE-754 addition order changes gameplay
/// bytes. This runtime is never serialized or hashed.
#[derive(Debug, Clone)]
pub(crate) struct PlanetMetricsRuntime {
    // Retaining both Arcs makes same-length/same-capacity COW drift visible.
    topology: std::sync::Arc<crate::state::FactoryTopology>,
    catalog: std::sync::Arc<crate::catalog::RuntimeCatalog>,
    entity_count: usize,
    planet_count: usize,
    committed_revision: u64,
    baseline: std::sync::Arc<Vec<PlanetMetricProbe>>,
    overrides: BTreeMap<usize, PlanetMetricProbe>,
    pending_entity_indices: BTreeSet<usize>,
    wake_all: bool,
    directory_fallback: bool,
    last_scan: PlanetMetricScan,
    #[cfg(test)]
    scan_history: Vec<PlanetMetricScan>,
    #[cfg(test)]
    indexed_selection_calls: usize,
    #[cfg(test)]
    flat_full_oracle_calls: usize,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct PlanetMetricScan {
    pub selected_rows: usize,
    pub total_rows: usize,
    pub stable_rows_skipped: usize,
    pub dense_fallback: bool,
    pub directory_fallback: bool,
    pub full_scan: bool,
}

struct PlanetMetricSelection {
    entity_indices: Vec<usize>,
    scan: PlanetMetricScan,
    fallback_detected: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PlanetMetricProbeMode {
    Indexed,
    #[cfg(test)]
    FlatFull,
    #[cfg(test)]
    IndexedFailAfterCollect,
}

impl PlanetMetricsRuntime {
    pub(crate) fn build(state: &CoreState, entities: &[Value]) -> Self {
        let planet_count = state.catalog.planets.len();
        let directory_fallback = state.identity.registry_fingerprint
            != crate::command::EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT
            || state.catalog.snapshot.registry_fingerprint
                != crate::command::EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT
            || entities.len() != state.entities.ids.len()
            || state.factory_topology.entity_planet_indices.len() != entities.len()
            || planet_count > u32::MAX as usize
            || state.factory_topology.orbital_collector_full_scan_required
            || state.factory_topology.quantum_endpoint_full_scan_required
            || state
                .factory_topology
                .system_space_station_full_scan_required
            || entities.iter().enumerate().any(|(index, entity)| {
                !validate_planet_metric_identity(state, entities, index, entity)
            });
        Self {
            topology: state.factory_topology.clone(),
            catalog: state.catalog.clone(),
            entity_count: entities.len(),
            planet_count,
            committed_revision: state.revision,
            baseline: std::sync::Arc::new(Vec::new()),
            overrides: BTreeMap::new(),
            pending_entity_indices: BTreeSet::new(),
            wake_all: true,
            directory_fallback,
            last_scan: PlanetMetricScan::default(),
            #[cfg(test)]
            scan_history: Vec::new(),
            #[cfg(test)]
            indexed_selection_calls: 0,
            #[cfg(test)]
            flat_full_oracle_calls: 0,
        }
    }

    pub(crate) fn bind_committed_revision(&mut self, revision: u64) {
        self.committed_revision = revision;
    }

    pub(crate) fn estimated_bytes(&self) -> u64 {
        let rows = self.entity_count as u64;
        let probe_bytes = std::mem::size_of::<PlanetMetricProbe>() as u64;
        let index_bytes = std::mem::size_of::<usize>() as u64;
        let tree_entry_bytes = index_bytes.saturating_mul(PLANET_METRIC_BTREE_WORDS_PER_ENTRY);
        let two_runtime_allocations = (std::mem::size_of::<Self>() as u64).saturating_mul(2);
        let two_full_probe_buffers = rows.saturating_mul(probe_bytes).saturating_mul(2);
        let full_selection_and_updates = rows
            .saturating_mul(index_bytes)
            .saturating_add(rows.saturating_mul(probe_bytes));
        let peak_pending_and_override_trees = if rows == 0 {
            0
        } else {
            PLANET_METRIC_BTREE_FIRST_NODE_BYTES
                .saturating_mul(4)
                .saturating_add(rows.saturating_mul(tree_entry_bytes).saturating_mul(2))
        };
        two_runtime_allocations
            .saturating_add(two_full_probe_buffers)
            .saturating_add(full_selection_and_updates)
            .saturating_add(peak_pending_and_override_trees)
    }

    pub(crate) fn wake_entity_indices(&mut self, indices: &[usize]) {
        if self.directory_fallback || self.wake_all {
            return;
        }
        for &entity_index in indices {
            if entity_index >= self.entity_count {
                self.force_directory_fallback();
                return;
            }
            self.pending_entity_indices.insert(entity_index);
        }
    }

    pub(crate) fn force_full(&mut self) {
        self.wake_all = true;
        self.pending_entity_indices.clear();
    }

    pub(crate) fn force_directory_fallback(&mut self) {
        self.directory_fallback = true;
        self.force_full();
    }

    fn select(
        &self,
        state: &CoreState,
        entities: &[Value],
        planet_count: usize,
    ) -> PlanetMetricSelection {
        let topology_changed = !std::sync::Arc::ptr_eq(&self.topology, &state.factory_topology)
            || !std::sync::Arc::ptr_eq(&self.catalog, &state.catalog)
            || self.committed_revision != state.revision
            || self.entity_count != entities.len()
            || self.entity_count != state.entities.ids.len()
            || self.planet_count != planet_count
            || self.planet_count != state.catalog.planets.len()
            || state.factory_topology.entity_planet_indices.len() != entities.len()
            || (self.baseline.len() != self.entity_count && !self.baseline.is_empty())
            || self
                .overrides
                .keys()
                .any(|&entity_index| entity_index >= self.entity_count)
            || self
                .pending_entity_indices
                .iter()
                .any(|&entity_index| entity_index >= self.entity_count);
        let identity_probe_all =
            self.directory_fallback || self.wake_all || self.baseline.len() != self.entity_count;
        let selected_identity_changed = !topology_changed
            && if identity_probe_all {
                entities.iter().enumerate().any(|(index, entity)| {
                    !validate_planet_metric_identity(state, entities, index, entity)
                })
            } else {
                self.pending_entity_indices.iter().any(|&index| {
                    !validate_planet_metric_identity(state, entities, index, &entities[index])
                })
            };
        let fallback_detected = topology_changed || selected_identity_changed;
        let active = self.pending_entity_indices.len();
        let dense_fallback = !self.directory_fallback
            && !fallback_detected
            && !self.wake_all
            && active > 0
            && active.saturating_mul(PLANET_METRIC_ACTIVE_DENSE_DENOMINATOR)
                >= self
                    .entity_count
                    .saturating_mul(PLANET_METRIC_ACTIVE_DENSE_NUMERATOR);
        let full_scan = self.directory_fallback
            || fallback_detected
            || self.wake_all
            || self.baseline.len() != self.entity_count
            || dense_fallback;
        let entity_indices: Vec<usize> = if full_scan {
            (0..entities.len()).collect()
        } else {
            self.pending_entity_indices.iter().copied().collect()
        };
        let selected_rows = entity_indices.len();
        PlanetMetricSelection {
            entity_indices,
            scan: PlanetMetricScan {
                selected_rows,
                total_rows: entities.len(),
                stable_rows_skipped: entities.len().saturating_sub(selected_rows),
                dense_fallback,
                directory_fallback: self.directory_fallback || fallback_detected,
                full_scan,
            },
            fallback_detected,
        }
    }

    fn commit_full(
        &mut self,
        probes: Vec<PlanetMetricProbe>,
        scan: PlanetMetricScan,
        fallback_detected: bool,
        mode: PlanetMetricProbeMode,
    ) {
        self.baseline = std::sync::Arc::new(probes);
        self.overrides.clear();
        self.pending_entity_indices.clear();
        self.wake_all = false;
        self.directory_fallback |= fallback_detected;
        self.last_scan = scan;
        #[cfg(test)]
        {
            self.scan_history.push(scan);
            match mode {
                PlanetMetricProbeMode::Indexed | PlanetMetricProbeMode::IndexedFailAfterCollect => {
                    self.indexed_selection_calls += 1
                }
                PlanetMetricProbeMode::FlatFull => self.flat_full_oracle_calls += 1,
            }
        }
        #[cfg(not(test))]
        let _ = (scan, mode);
    }

    fn commit_sparse(
        &mut self,
        selection: &PlanetMetricSelection,
        next_overrides: BTreeMap<usize, PlanetMetricProbe>,
    ) {
        self.overrides = next_overrides;
        for &entity_index in &selection.entity_indices {
            self.pending_entity_indices.remove(&entity_index);
        }
        self.wake_all = false;
        self.directory_fallback |= selection.fallback_detected;
        self.last_scan = selection.scan;
        #[cfg(test)]
        {
            self.scan_history.push(selection.scan);
            self.indexed_selection_calls += 1;
        }
    }

    #[cfg(test)]
    pub(crate) fn scan_history_for_test(&self) -> &[PlanetMetricScan] {
        &self.scan_history
    }

    #[cfg(test)]
    pub(crate) fn pending_rows_for_test(&self) -> Vec<usize> {
        self.pending_entity_indices.iter().copied().collect()
    }

    #[cfg(test)]
    pub(crate) fn selection_calls_for_test(&self) -> (usize, usize) {
        (self.indexed_selection_calls, self.flat_full_oracle_calls)
    }

    pub(crate) fn last_scan(&self) -> PlanetMetricScan {
        self.last_scan
    }
}

fn value_has_opaque_mod_key(value: &Value) -> bool {
    match value {
        Value::Object(object) => object
            .iter()
            .any(|(key, value)| key.starts_with("mod:") || value_has_opaque_mod_key(value)),
        Value::Array(values) => values.iter().any(value_has_opaque_mod_key),
        _ => false,
    }
}

fn metric_number_shape_is_closed(value: Option<&Value>) -> bool {
    matches!(value, None | Some(Value::Null))
        || value.and_then(Value::as_f64).is_some_and(f64::is_finite)
}

fn validate_planet_metric_identity(
    state: &CoreState,
    entities: &[Value],
    index: usize,
    entity: &Value,
) -> bool {
    let Some(object) = entity.as_object() else {
        return false;
    };
    if index >= entities.len()
        || index >= state.entities.ids.len()
        || value_has_opaque_mod_key(entity)
        || object.get("id").and_then(Value::as_str) != Some(&state.entities.ids[index])
        || object.get("kind").and_then(Value::as_str)
            != state
                .entities
                .kinds
                .get(index)
                .and_then(|symbol| state.symbols.resolve(*symbol))
        || object.get("planetId").and_then(Value::as_str)
            != state
                .entities
                .planets
                .get(index)
                .and_then(|symbol| state.symbols.resolve(*symbol))
        || !metric_number_shape_is_closed(object.get("productionRate"))
    {
        return false;
    }
    let expected_building = state
        .entities
        .buildings
        .get(index)
        .and_then(|symbol| state.symbols.resolve(*symbol))
        .filter(|id| !id.is_empty());
    let observed_building = object.get("buildingId").and_then(Value::as_str);
    if observed_building != expected_building {
        return false;
    }
    let Some(building_id) = observed_building else {
        return true;
    };
    let Some(building) = state.catalog.buildings.get(building_id) else {
        return false;
    };
    if matches!(building_id, "accumulator" | "energy_exchanger") {
        metric_number_shape_is_closed(object.get("storedEnergyMj"))
            && metric_number_shape_is_closed(object.get("machineCount"))
    } else if is_fuel_generator(building_id) {
        let Some(inputs) = object.get("inputs").and_then(Value::as_object) else {
            return false;
        };
        metric_number_shape_is_closed(object.get("fuelRemainingMj"))
            && metric_number_shape_is_closed(object.get("machineCount"))
            && object
                .get("fuelItemId")
                .and_then(Value::as_str)
                .is_some_and(|fuel_id| {
                    building.fuel_item_ids.iter().any(|id| id == fuel_id)
                        && state.catalog.items.contains_key(fuel_id)
                        && metric_number_shape_is_closed(inputs.get(fuel_id))
                })
    } else {
        true
    }
}

#[derive(Debug, Clone, Default)]
struct Consumer {
    entity_index: usize,
    demand_kw: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DispatchKind {
    Thermal,
    Fusion,
    ArtificialStar,
    Accumulator,
    Exchanger,
}

#[derive(Debug, Clone, PartialEq)]
struct PowerCandidate {
    entity_index: usize,
    capacity: f64,
    priority: usize,
    kind: DispatchKind,
}

#[derive(Debug, Clone)]
struct GridRuntime {
    generation_kw: f64,
    base_generation_kw: f64,
    demand_kw: f64,
    supplied_kw: f64,
    regular_supplied_kw: f64,
    factor: f64,
    wind_generation_kw: f64,
    solar_generation_kw: f64,
    geothermal_generation_kw: f64,
    thermal_generation_kw: f64,
    fusion_generation_kw: f64,
    artificial_star_generation_kw: f64,
    ray_generation_kw: f64,
    storage_discharge_kw: f64,
    storage_charge_kw: f64,
    stored_energy_mj: f64,
    storage_capacity_mj: f64,
    fuel_electric_energy_mj: f64,
    rated_fuel_generator_kw: f64,
    connected_entities: u64,
    disconnected_entities: u64,
    generator_count: f64,
    has_power_source: bool,
    consumers: [Vec<Consumer>; 4],
    disconnected_demand_kw: f64,
    dispatch_candidates: Vec<PowerCandidate>,
    accumulator_charge_candidates: Vec<PowerCandidate>,
    exchanger_charge_candidates: Vec<PowerCandidate>,
    power_output_by_entity: HashMap<usize, f64>,
    power_input_by_entity: HashMap<usize, f64>,
}

impl Default for GridRuntime {
    fn default() -> Self {
        Self {
            generation_kw: 0.0,
            base_generation_kw: 0.0,
            demand_kw: 0.0,
            supplied_kw: 0.0,
            regular_supplied_kw: 0.0,
            factor: 1.0,
            wind_generation_kw: 0.0,
            solar_generation_kw: 0.0,
            geothermal_generation_kw: 0.0,
            thermal_generation_kw: 0.0,
            fusion_generation_kw: 0.0,
            artificial_star_generation_kw: 0.0,
            ray_generation_kw: 0.0,
            storage_discharge_kw: 0.0,
            storage_charge_kw: 0.0,
            stored_energy_mj: 0.0,
            storage_capacity_mj: 0.0,
            fuel_electric_energy_mj: 0.0,
            rated_fuel_generator_kw: 0.0,
            connected_entities: 0,
            disconnected_entities: 0,
            generator_count: 0.0,
            has_power_source: false,
            consumers: std::array::from_fn(|_| Vec::new()),
            disconnected_demand_kw: 0.0,
            dispatch_candidates: Vec::new(),
            accumulator_charge_candidates: Vec::new(),
            exchanger_charge_candidates: Vec::new(),
            power_output_by_entity: HashMap::new(),
            power_input_by_entity: HashMap::new(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PowerSourceKind {
    Ray,
    Fuel,
    Accumulator,
    Exchanger,
    Wind,
    Solar,
    Geothermal,
}

#[derive(Debug, Clone, PartialEq)]
struct PowerSourceProbe {
    entity_index: usize,
    planet_index: usize,
    grid_index: usize,
    kind: PowerSourceKind,
    generator_count: f64,
    base_generation_kw: f64,
    wind_generation_kw: f64,
    solar_generation_kw: f64,
    geothermal_generation_kw: f64,
    ray_generation_kw: f64,
    stored_energy_mj: f64,
    storage_capacity_mj: f64,
    fuel_electric_energy_mj: f64,
    rated_fuel_generator_kw: f64,
    dispatch_candidate: Option<PowerCandidate>,
    accumulator_charge_candidate: Option<PowerCandidate>,
    exchanger_charge_candidate: Option<PowerCandidate>,
    power_output_kw: Option<f64>,
}

impl PowerSourceProbe {
    fn new(
        entity_index: usize,
        planet_index: usize,
        grid_index: usize,
        kind: PowerSourceKind,
        generator_count: f64,
    ) -> Self {
        Self {
            entity_index,
            planet_index,
            grid_index,
            kind,
            generator_count,
            base_generation_kw: 0.0,
            wind_generation_kw: 0.0,
            solar_generation_kw: 0.0,
            geothermal_generation_kw: 0.0,
            ray_generation_kw: 0.0,
            stored_energy_mj: 0.0,
            storage_capacity_mj: 0.0,
            fuel_electric_energy_mj: 0.0,
            rated_fuel_generator_kw: 0.0,
            dispatch_candidate: None,
            accumulator_charge_candidate: None,
            exchanger_charge_candidate: None,
            power_output_kw: None,
        }
    }
}

/// Compact, read-only part of a renewable power-source probe.
///
/// Ordinary exact simulation never writes any consumed field here:
/// `machineCount`, planet/grid membership and the three planet multipliers
/// change only through a command/import/topology rebuild. Runtime display
/// fields (`powerOutputKw`, `powerInputKw`, `utilization`) are deliberately
/// absent. Fuel, storage, exchangers and ray receivers are never represented
/// by this type and remain live probes on every internal step.
#[derive(Debug, Clone, Copy, PartialEq)]
struct StaticRenewablePowerProbe {
    entity_index: usize,
    planet_index: usize,
    grid_index: usize,
    kind: PowerSourceKind,
    generator_count: f64,
    output_kw: f64,
}

impl StaticRenewablePowerProbe {
    fn from_full(probe: &PowerSourceProbe) -> Option<Self> {
        matches!(
            probe.kind,
            PowerSourceKind::Wind | PowerSourceKind::Solar | PowerSourceKind::Geothermal
        )
        .then_some(Self {
            entity_index: probe.entity_index,
            planet_index: probe.planet_index,
            grid_index: probe.grid_index,
            kind: probe.kind,
            generator_count: probe.generator_count,
            output_kw: probe.base_generation_kw,
        })
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct PowerProbeScan {
    /// Rows that paid the JSON/catalog power-source probe in this step.
    pub selected_rows: usize,
    pub total_rows: usize,
    /// Compact rows replayed in persisted source order. This intentionally
    /// remains O(all power sources) to preserve observable f64 addition order.
    pub compact_replay_rows: usize,
    pub stable_rows_skipped: usize,
    pub dense_fallback: bool,
    pub directory_fallback: bool,
    pub full_scan: bool,
}

struct PowerProbeSelection {
    source_slots: Vec<usize>,
    scan: PowerProbeScan,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PowerProbeMode {
    Indexed,
    #[cfg(test)]
    FlatFull,
    #[cfg(test)]
    IndexedFailAfterCollect,
    #[cfg(test)]
    IndexedFailAfterRuntimeMutation,
}

/// Session-only writer-closed cache for power-source probes.
///
/// The immutable topology order is the stable index. A cold pass captures
/// only compact wind/solar/geothermal rows. Every source whose capacity can
/// change during exact simulation (fuel, accumulator, exchanger, ray power)
/// stays in `dynamic_source_slots` and is re-probed each internal step.
/// Commands/imports drop the complete runtime through the normal factory
/// domain invalidation path. Nothing here is serialized or hashed.
#[derive(Debug, Clone)]
pub(crate) struct PowerProbeRuntime {
    topology: std::sync::Arc<crate::state::FactoryTopology>,
    catalog: std::sync::Arc<crate::catalog::RuntimeCatalog>,
    entity_count: usize,
    source_count: usize,
    committed_revision: u64,
    static_baseline: std::sync::Arc<Vec<Option<StaticRenewablePowerProbe>>>,
    dynamic_source_slots: std::sync::Arc<Vec<usize>>,
    profile_signature: Option<Vec<[u64; 3]>>,
    wake_all: bool,
    directory_fallback: bool,
    #[cfg(test)]
    scan_history: Vec<PowerProbeScan>,
    #[cfg(test)]
    indexed_selection_calls: usize,
    #[cfg(test)]
    flat_full_oracle_calls: usize,
}

impl PowerProbeRuntime {
    pub(crate) fn build(state: &CoreState, entities: &[Value]) -> Self {
        let mut directory_fallback = state.identity.registry_fingerprint
            != crate::command::EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT
            || state.catalog.snapshot.registry_fingerprint
                != crate::command::EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT
            || entities.len() != state.entities.ids.len();
        let mut dynamic_source_slots = Vec::new();
        for (source_slot, &entity_index) in state
            .factory_topology
            .power_source_indices
            .iter()
            .enumerate()
        {
            let Some(entity) = entities.get(entity_index) else {
                directory_fallback = true;
                continue;
            };
            if !power_source_cache_identity_is_closed(state, entities, entity_index, entity) {
                directory_fallback = true;
            }
            if !static_renewable_source_is_closed(state, entity_index, entity) {
                dynamic_source_slots.push(source_slot);
            }
        }
        dynamic_source_slots.shrink_to_fit();
        Self {
            topology: state.factory_topology.clone(),
            catalog: state.catalog.clone(),
            entity_count: entities.len(),
            source_count: state.factory_topology.power_source_indices.len(),
            committed_revision: state.revision,
            static_baseline: std::sync::Arc::new(Vec::new()),
            dynamic_source_slots: std::sync::Arc::new(dynamic_source_slots),
            profile_signature: None,
            wake_all: true,
            directory_fallback,
            #[cfg(test)]
            scan_history: Vec::new(),
            #[cfg(test)]
            indexed_selection_calls: 0,
            #[cfg(test)]
            flat_full_oracle_calls: 0,
        }
    }

    pub(crate) fn bind_committed_revision(&mut self, revision: u64) {
        self.committed_revision = revision;
    }

    pub(crate) fn estimated_bytes(&self) -> u64 {
        let sources = self.source_count as u64;
        let dynamic = self.dynamic_source_slots.capacity() as u64;
        let profile_rows = self
            .profile_signature
            .as_ref()
            .map(Vec::capacity)
            .unwrap_or(0) as u64;
        // Include candidate COW and one full legacy probe buffer so the
        // authority memory budget remains conservative during a cold/dense
        // pass instead of reporting only the compact steady-state baseline.
        (std::mem::size_of::<Self>() as u64)
            .saturating_mul(2)
            .saturating_add(
                sources
                    .saturating_mul(std::mem::size_of::<Option<StaticRenewablePowerProbe>>() as u64)
                    .saturating_mul(2),
            )
            .saturating_add(
                sources.saturating_mul(std::mem::size_of::<Option<PowerSourceProbe>>() as u64),
            )
            // A cold/dense candidate simultaneously owns the persisted-order
            // source-slot selection and the derived settlement entity rows.
            .saturating_add(
                sources
                    .saturating_mul(std::mem::size_of::<usize>() as u64)
                    .saturating_mul(2),
            )
            .saturating_add(dynamic.saturating_mul(std::mem::size_of::<usize>() as u64))
            // Arc::make_mut keeps the committed signature alive while the
            // candidate builds its replacement.
            .saturating_add(
                profile_rows
                    .saturating_mul(std::mem::size_of::<[u64; 3]>() as u64)
                    .saturating_mul(2),
            )
    }

    fn select(
        &self,
        state: &CoreState,
        entities: &[Value],
        profiles: &[PlanetProfile],
        mode: PowerProbeMode,
    ) -> PowerProbeSelection {
        let profile_signature = power_probe_profile_signature(profiles);
        let directory_fallback = self.directory_fallback
            || state.revision != self.committed_revision
            || !std::sync::Arc::ptr_eq(&self.topology, &state.factory_topology)
            || !std::sync::Arc::ptr_eq(&self.catalog, &state.catalog)
            || entities.len() != self.entity_count
            || self.source_count != state.factory_topology.power_source_indices.len()
            || self.static_baseline.len() != self.source_count
            || self.profile_signature.as_ref() != Some(&profile_signature);
        let dense_fallback = !self.dynamic_source_slots.is_empty()
            && self
                .dynamic_source_slots
                .len()
                .saturating_mul(POWER_PROBE_ACTIVE_DENSE_DENOMINATOR)
                >= self
                    .source_count
                    .saturating_mul(POWER_PROBE_ACTIVE_DENSE_NUMERATOR);
        #[cfg(test)]
        let flat_full = mode == PowerProbeMode::FlatFull;
        #[cfg(not(test))]
        let flat_full = {
            let _ = mode;
            false
        };
        let full_scan = flat_full || self.wake_all || directory_fallback || dense_fallback;
        let source_slots = if full_scan {
            (0..self.source_count).collect()
        } else {
            self.dynamic_source_slots.as_ref().clone()
        };
        PowerProbeSelection {
            scan: PowerProbeScan {
                selected_rows: source_slots.len(),
                total_rows: self.source_count,
                compact_replay_rows: self.source_count,
                stable_rows_skipped: self.source_count.saturating_sub(source_slots.len()),
                dense_fallback,
                directory_fallback,
                full_scan,
            },
            source_slots,
        }
    }

    fn commit_full(
        &mut self,
        probes: &[Option<PowerSourceProbe>],
        profiles: &[PlanetProfile],
        mut scan: PowerProbeScan,
        mode: PowerProbeMode,
    ) {
        let mut dynamic_slots = self.dynamic_source_slots.iter().copied().peekable();
        let mut malformed_static = false;
        let baseline = probes
            .iter()
            .enumerate()
            .map(|(source_slot, probe)| {
                if dynamic_slots.peek().copied() == Some(source_slot) {
                    dynamic_slots.next();
                    None
                } else {
                    let compact = probe
                        .as_ref()
                        .and_then(StaticRenewablePowerProbe::from_full);
                    malformed_static |= compact.is_none();
                    compact
                }
            })
            .collect::<Vec<_>>();
        self.static_baseline = std::sync::Arc::new(baseline);
        self.profile_signature = Some(power_probe_profile_signature(profiles));
        self.directory_fallback |= malformed_static;
        self.wake_all = false;
        scan.directory_fallback |= malformed_static;
        #[cfg(test)]
        {
            self.scan_history.push(scan);
            if mode == PowerProbeMode::FlatFull {
                self.flat_full_oracle_calls += 1;
            } else {
                self.indexed_selection_calls += 1;
            }
        }
        #[cfg(not(test))]
        let _ = (scan, mode);
    }

    fn commit_sparse(&mut self, scan: PowerProbeScan) {
        #[cfg(test)]
        {
            self.scan_history.push(scan);
            self.indexed_selection_calls += 1;
        }
        #[cfg(not(test))]
        let _ = scan;
    }

    #[cfg(test)]
    pub(crate) fn scan_history_for_test(&self) -> &[PowerProbeScan] {
        &self.scan_history
    }

    #[cfg(test)]
    pub(crate) fn selection_calls_for_test(&self) -> (usize, usize) {
        (self.indexed_selection_calls, self.flat_full_oracle_calls)
    }
}

fn power_probe_profile_signature(profiles: &[PlanetProfile]) -> Vec<[u64; 3]> {
    profiles
        .iter()
        .map(|profile| {
            [
                profile.wind_multiplier.to_bits(),
                profile.solar_power_multiplier.to_bits(),
                profile.geothermal_multiplier.to_bits(),
            ]
        })
        .collect()
}

fn power_source_cache_identity_is_closed(
    state: &CoreState,
    entities: &[Value],
    entity_index: usize,
    entity: &Value,
) -> bool {
    if !validate_planet_metric_identity(state, entities, entity_index, entity) {
        return false;
    }
    let Some(object) = entity.as_object() else {
        return false;
    };
    let planet = state.factory_topology.entity_planet_indices[entity_index];
    let grid = state.factory_topology.entity_grid_indices[entity_index];
    planet != usize::MAX
        && state.catalog.planets.get(planet).is_some()
        && grid < GRID_IDS.len()
        && object.get("powerGridId").and_then(Value::as_str) == Some(GRID_IDS[grid])
        && metric_number_shape_is_closed(object.get("machineCount"))
}

fn static_renewable_source_is_closed(
    state: &CoreState,
    entity_index: usize,
    entity: &Value,
) -> bool {
    let Some(object) = entity.as_object() else {
        return false;
    };
    object.get("kind").and_then(Value::as_str) == Some("power")
        && state
            .entities
            .buildings
            .get(entity_index)
            .and_then(|symbol| state.symbols.resolve(*symbol))
            .is_some_and(is_independent_renewable_power_facility)
        && object
            .get("buildingId")
            .and_then(Value::as_str)
            .is_some_and(is_independent_renewable_power_facility)
        && metric_number_shape_is_closed(object.get("machineCount"))
}

#[derive(Debug, Clone, Copy)]
struct PowerDemandProbe {
    entity_index: usize,
    planet_index: usize,
    grid_index: usize,
    demand_kw: f64,
    priority: usize,
    demand_active: bool,
    zero_if_disconnected: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct RenewablePowerFacilityPatch {
    entity_index: usize,
    power_output_kw: f64,
    power_input_kw: f64,
    utilization: f64,
    #[cfg(test)]
    worker_index: Option<usize>,
}

fn is_independent_renewable_power_facility(building_id: &str) -> bool {
    matches!(
        building_id,
        "wind_turbine" | "solar_panel" | "geothermal_power_station"
    )
}

fn collect_renewable_power_facility_patches_with_runtime(
    runtime: &DeterministicRuntime,
    state: &CoreState,
    entities: &[Value],
    power_source_settlement_indices: &[usize],
    grids: &[GridRuntime],
) -> anyhow::Result<Vec<RenewablePowerFacilityPatch>> {
    let indices = power_source_settlement_indices
        .iter()
        .copied()
        .filter(|&entity_index| {
            state
                .symbols
                .resolve(state.entities.buildings[entity_index])
                .is_some_and(is_independent_renewable_power_facility)
        })
        .collect::<Vec<_>>();
    runtime.indexed_try_map(&indices, |_, &entity_index| {
        let object = entities[entity_index]
            .as_object()
            .ok_or_else(|| anyhow!("native renewable power facility is not an object"))?;
        let building_id = state
            .symbols
            .resolve(state.entities.buildings[entity_index])
            .unwrap_or_default();
        let building = state
            .catalog
            .buildings
            .get(building_id)
            .ok_or_else(|| anyhow!("native renewable power facility catalog is missing"))?;
        let planet = state.factory_topology.entity_planet_indices[entity_index];
        let grid = state.factory_topology.entity_grid_indices[entity_index];
        if planet == usize::MAX || grid == usize::MAX {
            bail!("native renewable power facility topology is unknown");
        }
        let grid_slot = planet
            .checked_mul(GRID_IDS.len())
            .and_then(|offset| offset.checked_add(grid))
            .filter(|&slot| slot < grids.len())
            .ok_or_else(|| anyhow!("native renewable power facility grid is missing"))?;
        let output = grids[grid_slot]
            .power_output_by_entity
            .get(&entity_index)
            .copied()
            .unwrap_or(0.0);
        let input = grids[grid_slot]
            .power_input_by_entity
            .get(&entity_index)
            .copied()
            .unwrap_or(0.0);
        let rated = building.power_generation_kw * finite_number(object.get("machineCount"));
        Ok(RenewablePowerFacilityPatch {
            entity_index,
            power_output_kw: rounded(output, 2),
            power_input_kw: rounded(input, 2),
            utilization: if rated > EPSILON {
                rounded(output.max(input) / rated, 4)
            } else {
                0.0
            },
            #[cfg(test)]
            worker_index: rayon::current_thread_index(),
        })
    })
}

fn apply_renewable_power_facility_patch(
    entity: &mut Value,
    patch: RenewablePowerFacilityPatch,
) -> anyhow::Result<()> {
    let object = entity_object(entity)?;
    set_number(object, "powerOutputKw", patch.power_output_kw)?;
    set_number(object, "powerInputKw", patch.power_input_kw)?;
    set_number(object, "utilization", patch.utilization)?;
    set_number(object, "productionRate", 0.0)
}

// Built-in recipes currently have at most two outputs. Keep a wider inline
// budget for content packs, but conservatively leave unusually wide MOD
// recipes on the byte-identical serial path instead of allocating one result
// vector per machine in the hot loop.
const MAX_PARALLEL_LOCAL_MACHINE_OUTPUTS: usize = 8;

#[derive(Debug, Clone, Copy)]
struct MachineLocalSettlementDelta {
    produced: [f64; MAX_PARALLEL_LOCAL_MACHINE_OUTPUTS],
    produced_len: usize,
}

impl Default for MachineLocalSettlementDelta {
    fn default() -> Self {
        Self {
            produced: [0.0; MAX_PARALLEL_LOCAL_MACHINE_OUTPUTS],
            produced_len: 0,
        }
    }
}

#[derive(Debug)]
struct MachineLocalSettlementTask {
    entity_index: usize,
    entity: Value,
    context: MachineLocalSettlementContext,
    result: Option<anyhow::Result<MachineLocalSettlementDelta>>,
}

#[derive(Clone, Copy, Debug)]
struct MachineLocalSettlementContext {
    technology_available: bool,
    industrial_speed: f64,
    launch_factor: f64,
}

#[derive(Debug)]
struct MachineLocalSettlementOutcome {
    entity_index: usize,
    result: anyhow::Result<MachineLocalSettlementDelta>,
}

#[derive(Debug)]
struct MachineLocalSettlementBatch {
    entity_indices: Vec<usize>,
}

#[derive(Debug, Default)]
struct MachineLocalSettlementPlan {
    batches: Vec<MachineLocalSettlementBatch>,
    parallel_entity_count: usize,
    serial_fallback_count: usize,
    global_barrier_count: usize,
}

enum MachineProductionEvent {
    ParallelTask(usize),
    Inline { item_id: String, produced: f64 },
}

#[derive(Clone, Copy, Debug)]
struct VeinSettlementContext {
    production_buffer_limit: f64,
    mining_research_multiplier: f64,
    vein_level: f64,
    finite_consumption_tenths: f64,
    infinite_resource_mode: bool,
    seconds: f64,
}

#[derive(Debug)]
enum VeinSettlementDelta {
    Noop,
    Idle {
        power_factor: f64,
    },
    Active {
        resource: String,
        power_factor: f64,
        output_amount: f64,
        finite_resource: Option<(f64, f64)>,
        progress: f64,
        production_rate: f64,
        produced: f64,
    },
}

#[derive(Debug)]
struct VeinSettlementOutcome {
    entity_index: usize,
    result: anyhow::Result<VeinSettlementDelta>,
}

struct VeinProbeEnvironment<'a> {
    state: &'a CoreState,
    entities: &'a [Value],
    profiles: &'a [PlanetProfile],
    grids: &'a [GridRuntime],
    power_factors: &'a HashMap<usize, f64>,
    output_credits: &'a crate::belts::OutputCredits,
    context: VeinSettlementContext,
}

fn rounded(value: f64, digits: i32) -> f64 {
    let scale = 10_f64.powi(digits);
    (value * scale).round() / scale
}

fn finite_number(value: Option<&Value>) -> f64 {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .unwrap_or(0.0)
}

fn quantum_boundary_changed_station_inventory(
    flow: Option<&crate::quantum_logistics::BoundaryFlow>,
) -> bool {
    flow.is_some_and(crate::quantum_logistics::BoundaryFlow::has_downloads)
}

fn string_at<'a>(object: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    object.get(key).and_then(Value::as_str)
}

fn bool_at(value: Option<&Value>, path: &[&str]) -> bool {
    let mut current = value;
    for key in path {
        current = current
            .and_then(Value::as_object)
            .and_then(|object| object.get(*key));
    }
    current.and_then(Value::as_bool).unwrap_or(false)
}

fn number_at(value: Option<&Value>, path: &[&str]) -> f64 {
    let mut current = value;
    for key in path {
        current = current
            .and_then(Value::as_object)
            .and_then(|object| object.get(*key));
    }
    finite_number(current)
}

fn grid_index(entity: &Map<String, Value>) -> Option<usize> {
    let id = string_at(entity, "powerGridId").unwrap_or("grid-a");
    GRID_IDS.iter().position(|candidate| *candidate == id)
}

fn normalized_buffer_limit(value: Option<&Value>) -> f64 {
    let value = value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .unwrap_or(DEFAULT_BUILDING_BUFFER_LIMIT)
        .floor();
    value.clamp(MIN_BUILDING_BUFFER_LIMIT, MAX_BUILDING_BUFFER_LIMIT)
}

fn stacked_capacity(base_capacity: f64, count: f64, limit: f64) -> f64 {
    let base = base_capacity.max(0.0).floor();
    let count = count.floor().max(1.0);
    if base == 0.0 {
        0.0
    } else if base > limit / count {
        limit
    } else {
        (base * count).min(limit)
    }
}

fn item_amount(entity: &Map<String, Value>, record: &str, item_id: &str) -> f64 {
    entity
        .get(record)
        .and_then(Value::as_object)
        .and_then(|values| values.get(item_id))
        .map(|value| finite_number(Some(value)))
        .unwrap_or(0.0)
}

fn is_fuel_generator(building_id: &str) -> bool {
    matches!(
        building_id,
        "thermal_power_plant" | "mini_fusion_power_plant" | "artificial_star"
    )
}

fn fuel_energy_available(
    state: &CoreState,
    entity: &Map<String, Value>,
    building: &BuildingDefinition,
) -> f64 {
    let Some(fuel_item_id) = string_at(entity, "fuelItemId") else {
        return 0.0;
    };
    if !building.fuel_item_ids.iter().any(|id| id == fuel_item_id) {
        return 0.0;
    }
    let energy_per_item = state
        .catalog
        .items
        .get(fuel_item_id)
        .map(|item| item.fuel_energy_mj)
        .unwrap_or(0.0);
    finite_number(entity.get("fuelRemainingMj")).max(0.0)
        + (item_amount(entity, "inputs", fuel_item_id) + EPSILON).floor() * energy_per_item
}

fn energy_capacity(entity: &Map<String, Value>, building: &BuildingDefinition) -> f64 {
    building.energy_capacity_mj * finite_number(entity.get("machineCount"))
}

fn stored_energy(entity: &Map<String, Value>, building: &BuildingDefinition) -> f64 {
    finite_number(entity.get("storedEnergyMj"))
        .max(0.0)
        .min(energy_capacity(entity, building))
}

#[cfg(test)]
fn collect_ordered_planet_metric_probes_with_runtime<T, R, F>(
    runtime: &DeterministicRuntime,
    values: &[T],
    probe: F,
) -> anyhow::Result<Vec<R>>
where
    T: Sync,
    R: Send,
    F: Fn(usize, &T) -> anyhow::Result<R> + Send + Sync,
{
    runtime.indexed_try_map(values, probe)
}

fn collect_planet_metric_probes_with_runtime(
    runtime: &DeterministicRuntime,
    state: &CoreState,
    entities: &[Value],
    entity_indices: &[usize],
) -> anyhow::Result<Vec<PlanetMetricProbe>> {
    runtime.indexed_try_map(entity_indices, |_, &entity_index| {
        probe_planet_metric(state, entity_index, &entities[entity_index])
    })
}

#[cfg(test)]
fn collect_flat_full_planet_metric_probes_with_runtime(
    runtime: &DeterministicRuntime,
    state: &CoreState,
    entities: &[Value],
) -> anyhow::Result<Vec<PlanetMetricProbe>> {
    // This range is intentionally independent from PlanetMetricsRuntime
    // selection. Tests use it as the real flat-full oracle.
    runtime.indexed_try_map_range(
        0..entities.len(),
        |entity_index| probe_planet_metric(state, entity_index, &entities[entity_index]),
        |_| PlanetMetricProbe::default(),
    )
}

fn probe_planet_metric(
    state: &CoreState,
    entity_index: usize,
    entity: &Value,
) -> anyhow::Result<PlanetMetricProbe> {
    let Some(entity) = entity.as_object() else {
        return Ok(PlanetMetricProbe::default());
    };
    let planet_index = state.factory_topology.entity_planet_indices[entity_index];
    if planet_index == usize::MAX {
        return Ok(PlanetMetricProbe::default());
    }
    let planet_index = u32::try_from(planet_index)
        .map_err(|_| anyhow!("native power reserve planet index overflowed"))?;
    let mut probe = PlanetMetricProbe {
        production_rate: finite_number(entity.get("productionRate")),
        planet_index,
        ..PlanetMetricProbe::default()
    };
    let Some(building_id) = string_at(entity, "buildingId") else {
        return Ok(probe);
    };
    let building = state
        .catalog
        .buildings
        .get(building_id)
        .ok_or_else(|| anyhow!("native power reserve building is missing"))?;
    if matches!(building_id, "accumulator" | "energy_exchanger") {
        probe.reserve_kind = PlanetReserveKind::StoredEnergy;
        probe.reserve_primary = stored_energy(entity, building);
        probe.reserve_secondary = energy_capacity(entity, building);
    } else if is_fuel_generator(building_id) {
        probe.reserve_kind = PlanetReserveKind::Fuel;
        probe.reserve_primary =
            fuel_energy_available(state, entity, building) * building.fuel_efficiency;
        probe.reserve_secondary =
            building.power_generation_kw * finite_number(entity.get("machineCount"));
    }
    Ok(probe)
}

type PlanetPowerReserves = (f64, f64, f64, f64);

fn fold_planet_metric_probes<I>(
    probes: I,
    planet_count: usize,
) -> anyhow::Result<(Vec<f64>, Vec<PlanetPowerReserves>)>
where
    I: IntoIterator<Item = PlanetMetricProbe>,
{
    let mut total_items_before_global = vec![0.0; planet_count];
    let mut power_reserves_by_planet = vec![(0.0, 0.0, 0.0, 0.0); planet_count];
    // Worker scheduling must never decide an IEEE-754 accumulation order.
    // Only this persisted-row-order serial replay touches per-planet totals.
    for probe in probes {
        if probe.planet_index == u32::MAX {
            continue;
        }
        let planet = usize::try_from(probe.planet_index)
            .map_err(|_| anyhow!("native power reserve planet index overflowed"))?;
        let total_items = total_items_before_global
            .get_mut(planet)
            .ok_or_else(|| anyhow!("native power reserve planet topology is unknown"))?;
        *total_items += probe.production_rate;
        let reserves = power_reserves_by_planet
            .get_mut(planet)
            .expect("validated native power reserve planet disappeared");
        match probe.reserve_kind {
            PlanetReserveKind::None => {}
            PlanetReserveKind::StoredEnergy => {
                reserves.0 += probe.reserve_primary;
                reserves.1 += probe.reserve_secondary;
            }
            PlanetReserveKind::Fuel => {
                reserves.2 += probe.reserve_primary;
                reserves.3 += probe.reserve_secondary;
            }
        }
    }
    Ok((total_items_before_global, power_reserves_by_planet))
}

fn fold_cached_planet_metric_probes(
    baseline: &[PlanetMetricProbe],
    overrides: &BTreeMap<usize, PlanetMetricProbe>,
    planet_count: usize,
) -> anyhow::Result<(Vec<f64>, Vec<PlanetPowerReserves>)> {
    let mut override_iter = overrides.iter().peekable();
    fold_planet_metric_probes(
        baseline.iter().enumerate().map(move |(index, probe)| {
            override_iter
                .next_if(|(override_index, _)| **override_index == index)
                .map(|(_, override_probe)| *override_probe)
                .unwrap_or(*probe)
        }),
        planet_count,
    )
}

fn collect_planet_metrics_with_runtime(
    runtime: &DeterministicRuntime,
    state: &CoreState,
    entities: &[Value],
    planet_count: usize,
    planet_metrics_runtime: &mut std::sync::Arc<PlanetMetricsRuntime>,
    mode: PlanetMetricProbeMode,
) -> anyhow::Result<(Vec<f64>, Vec<PlanetPowerReserves>)> {
    #[cfg(test)]
    if mode == PlanetMetricProbeMode::FlatFull {
        let probes = collect_flat_full_planet_metric_probes_with_runtime(runtime, state, entities)?;
        let metrics = fold_planet_metric_probes(probes.iter().copied(), planet_count)?;
        let scan = PlanetMetricScan {
            selected_rows: entities.len(),
            total_rows: entities.len(),
            stable_rows_skipped: 0,
            dense_fallback: false,
            directory_fallback: planet_metrics_runtime.directory_fallback,
            full_scan: true,
        };
        std::sync::Arc::make_mut(planet_metrics_runtime).commit_full(probes, scan, false, mode);
        return Ok(metrics);
    }

    let selection = planet_metrics_runtime.select(state, entities, planet_count);
    let probes = collect_planet_metric_probes_with_runtime(
        runtime,
        state,
        entities,
        &selection.entity_indices,
    )?;
    if selection.scan.full_scan {
        let metrics = fold_planet_metric_probes(probes.iter().copied(), planet_count)?;
        std::sync::Arc::make_mut(planet_metrics_runtime).commit_full(
            probes,
            selection.scan,
            selection.fallback_detected,
            mode,
        );
        return Ok(metrics);
    }

    if selection.entity_indices.len() != probes.len() {
        bail!("native planet metric probe selection diverged");
    }
    let mut next_overrides = planet_metrics_runtime.overrides.clone();
    for (&entity_index, probe) in selection.entity_indices.iter().zip(probes) {
        next_overrides.insert(entity_index, probe);
    }
    let metrics = fold_cached_planet_metric_probes(
        &planet_metrics_runtime.baseline,
        &next_overrides,
        planet_count,
    )?;
    let compact = !next_overrides.is_empty()
        && next_overrides
            .len()
            .saturating_mul(PLANET_METRIC_ACTIVE_DENSE_DENOMINATOR)
            >= entities
                .len()
                .saturating_mul(PLANET_METRIC_ACTIVE_DENSE_NUMERATOR);
    let runtime = std::sync::Arc::make_mut(planet_metrics_runtime);
    runtime.commit_sparse(&selection, next_overrides);
    if compact {
        let compacted = runtime
            .baseline
            .iter()
            .enumerate()
            .map(|(index, probe)| runtime.overrides.get(&index).copied().unwrap_or(*probe))
            .collect::<Vec<_>>();
        runtime.baseline = std::sync::Arc::new(compacted);
        runtime.overrides.clear();
    }
    Ok(metrics)
}

fn item_output_free(
    entity: &Map<String, Value>,
    building: &BuildingDefinition,
    item_id: &str,
    buffer_limit: f64,
) -> f64 {
    let capacity = stacked_capacity(
        building.output_capacity,
        finite_number(entity.get("machineCount")),
        buffer_limit,
    );
    ((capacity - item_amount(entity, "outputs", item_id)).max(0.0) + EPSILON).floor()
}

fn accumulator_energy_mj(state: &CoreState) -> anyhow::Result<f64> {
    let energy = state
        .catalog
        .buildings
        .get("accumulator")
        .map(|building| building.energy_capacity_mj)
        .unwrap_or(0.0);
    if !energy.is_finite() || energy <= EPSILON {
        return Err(anyhow!("native accumulator energy catalog is invalid"));
    }
    Ok(energy)
}

fn default_generation_priority(building_id: &str) -> usize {
    match building_id {
        "energy_exchanger" => 2,
        "accumulator" | "thermal_power_plant" | "mini_fusion_power_plant" | "artificial_star" => 1,
        _ => 3,
    }
}

fn generation_priority(entity: &Map<String, Value>, building_id: &str) -> usize {
    entity
        .get("generationPriority")
        .and_then(Value::as_u64)
        .map(|value| value.clamp(1, 3) as usize)
        .unwrap_or_else(|| default_generation_priority(building_id))
}

fn allocate_power(
    candidates: &[PowerCandidate],
    requested_kw: f64,
    outputs: &mut HashMap<usize, f64>,
) -> f64 {
    let capacity = candidates
        .iter()
        .map(|candidate| candidate.capacity)
        .sum::<f64>();
    let allocated = requested_kw.max(0.0).min(capacity);
    for candidate in candidates {
        outputs.insert(
            candidate.entity_index,
            if capacity > EPSILON {
                allocated * candidate.capacity / capacity
            } else {
                0.0
            },
        );
    }
    allocated
}

fn allocate_power_by_priority(
    candidates: &[PowerCandidate],
    requested_kw: f64,
    outputs: &mut HashMap<usize, f64>,
) -> f64 {
    let mut remaining = requested_kw.max(0.0);
    let mut allocated = 0.0;
    for priority in [3_usize, 2, 1] {
        let group = candidates
            .iter()
            .filter(|candidate| candidate.priority == priority)
            .cloned()
            .collect::<Vec<_>>();
        let supplied = allocate_power(&group, remaining, outputs);
        allocated += supplied;
        remaining -= supplied;
        if remaining <= EPSILON {
            break;
        }
    }
    allocated
}

fn power_generation_capacity_in_js_order(runtime: &GridRuntime) -> (f64, f64) {
    // JavaScript accumulates each source class independently while scanning
    // entities, then performs these exact left-associated additions. Keeping
    // the class totals separate matters above 2^53: mixing a small renewable
    // term into every large ray-receiver term can change the saved value by
    // one ULP even when every individual probe is identical.
    let mut base_generation_kw = runtime.wind_generation_kw;
    base_generation_kw += runtime.solar_generation_kw;
    base_generation_kw += runtime.geothermal_generation_kw;
    base_generation_kw += runtime.ray_generation_kw;

    // calculatePower() likewise reduces the three dispatch classes
    // independently, preserving entity order inside each class, before it
    // adds exchanger, fuel, and accumulator capacity to the base in order.
    let mut exchanger_capacity_kw = 0.0;
    let mut fuel_capacity_kw = 0.0;
    let mut accumulator_capacity_kw = 0.0;
    for candidate in &runtime.dispatch_candidates {
        match candidate.kind {
            DispatchKind::Exchanger => exchanger_capacity_kw += candidate.capacity,
            DispatchKind::Thermal | DispatchKind::Fusion | DispatchKind::ArtificialStar => {
                fuel_capacity_kw += candidate.capacity;
            }
            DispatchKind::Accumulator => accumulator_capacity_kw += candidate.capacity,
        }
    }
    let mut generation_kw = base_generation_kw;
    generation_kw += exchanger_capacity_kw;
    generation_kw += fuel_capacity_kw;
    generation_kw += accumulator_capacity_kw;
    (base_generation_kw, generation_kw)
}

fn probe_power_source(
    state: &CoreState,
    entities: &[Value],
    reception: &crate::dyson::Reception,
    profiles: &[PlanetProfile],
    production_buffer_limit: f64,
    seconds: f64,
    entity_index: usize,
) -> anyhow::Result<Option<PowerSourceProbe>> {
    let object = entities[entity_index]
        .as_object()
        .ok_or_else(|| anyhow!("native simple factory entity is not an object"))?;
    let is_ray_power = string_at(object, "kind") == Some("machine")
        && string_at(object, "buildingId") == Some("ray_receiver")
        && string_at(object, "recipeId") == Some("ray_power");
    if string_at(object, "kind") != Some("power") && !is_ray_power {
        return Ok(None);
    }
    let planet_index = state.factory_topology.entity_planet_indices[entity_index];
    let grid_index = state.factory_topology.entity_grid_indices[entity_index];
    if planet_index == usize::MAX || grid_index == usize::MAX {
        bail!("native simple factory entity power topology is unknown");
    }
    let building_id = string_at(object, "buildingId").unwrap_or_default();
    let building = state
        .catalog
        .buildings
        .get(building_id)
        .ok_or_else(|| anyhow!("native simple factory renewable catalog is missing"))?;
    let machine_count = finite_number(object.get("machineCount"));
    let source_kind = if is_ray_power {
        PowerSourceKind::Ray
    } else if is_fuel_generator(building_id) {
        PowerSourceKind::Fuel
    } else {
        match building_id {
            "accumulator" => PowerSourceKind::Accumulator,
            "energy_exchanger" => PowerSourceKind::Exchanger,
            "solar_panel" => PowerSourceKind::Solar,
            "geothermal_power_station" => PowerSourceKind::Geothermal,
            _ => PowerSourceKind::Wind,
        }
    };
    let mut probe = PowerSourceProbe::new(
        entity_index,
        planet_index,
        grid_index,
        source_kind,
        machine_count,
    );
    if is_ray_power {
        let output = string_at(object, "id")
            .and_then(|entity_id| reception.ray_power_by_entity.get(entity_id))
            .copied()
            .unwrap_or(0.0);
        probe.base_generation_kw = output;
        probe.ray_generation_kw = output;
        probe.power_output_kw = Some(output);
        return Ok(Some(probe));
    }
    if is_fuel_generator(building_id) {
        let available = fuel_energy_available(state, object, building);
        let rated = building.power_generation_kw * machine_count;
        let capacity = rated.min(available * building.fuel_efficiency * 1_000.0 / seconds);
        probe.fuel_electric_energy_mj = available * building.fuel_efficiency;
        probe.rated_fuel_generator_kw = rated;
        if capacity > EPSILON {
            probe.dispatch_candidate = Some(PowerCandidate {
                entity_index,
                capacity,
                priority: generation_priority(object, building_id),
                kind: match building_id {
                    "thermal_power_plant" => DispatchKind::Thermal,
                    "mini_fusion_power_plant" => DispatchKind::Fusion,
                    _ => DispatchKind::ArtificialStar,
                },
            });
        }
        return Ok(Some(probe));
    }
    if building_id == "accumulator" {
        let stored = stored_energy(object, building);
        let capacity_mj = energy_capacity(object, building);
        probe.stored_energy_mj = stored;
        probe.storage_capacity_mj = capacity_mj;
        let discharge =
            (building.power_generation_kw * machine_count).min(stored * 1_000.0 / seconds);
        let charge = (building.power_charge_kw * machine_count)
            .min((capacity_mj - stored).max(0.0) * 1_000.0 / seconds);
        if discharge > EPSILON {
            probe.dispatch_candidate = Some(PowerCandidate {
                entity_index,
                capacity: discharge,
                priority: generation_priority(object, building_id),
                kind: DispatchKind::Accumulator,
            });
        }
        if charge > EPSILON {
            probe.accumulator_charge_candidate = Some(PowerCandidate {
                entity_index,
                capacity: charge,
                priority: 1,
                kind: DispatchKind::Accumulator,
            });
        }
        return Ok(Some(probe));
    }
    if building_id == "energy_exchanger" {
        let cell_energy_mj = accumulator_energy_mj(state)?;
        let stored = stored_energy(object, building);
        probe.stored_energy_mj = stored;
        probe.storage_capacity_mj = energy_capacity(object, building);
        let active_cells = if stored > EPSILON { 1.0 } else { 0.0 };
        let mode = string_at(object, "energyMode").unwrap_or("charge");
        if mode == "discharge" {
            let queued = (item_amount(object, "inputs", "charged_accumulator") + EPSILON).floor();
            let usable = (active_cells + queued).min(item_output_free(
                object,
                building,
                "accumulator",
                production_buffer_limit,
            ));
            let available = if usable > 0.0 {
                stored + (usable - active_cells).max(0.0) * cell_energy_mj
            } else {
                0.0
            };
            let discharge =
                (building.power_generation_kw * machine_count).min(available * 1_000.0 / seconds);
            if discharge > EPSILON {
                probe.dispatch_candidate = Some(PowerCandidate {
                    entity_index,
                    capacity: discharge,
                    priority: generation_priority(object, building_id),
                    kind: DispatchKind::Exchanger,
                });
            }
        } else {
            let queued = (item_amount(object, "inputs", "accumulator") + EPSILON).floor();
            let usable = (active_cells + queued).min(item_output_free(
                object,
                building,
                "charged_accumulator",
                production_buffer_limit,
            ));
            let available = if usable > 0.0 {
                usable * cell_energy_mj - stored
            } else {
                0.0
            };
            let charge = (building.power_charge_kw * machine_count)
                .min(available.max(0.0) * 1_000.0 / seconds);
            if charge > EPSILON {
                probe.exchanger_charge_candidate = Some(PowerCandidate {
                    entity_index,
                    capacity: charge,
                    priority: 2,
                    kind: DispatchKind::Exchanger,
                });
            }
        }
        return Ok(Some(probe));
    }
    let multiplier = match building_id {
        "solar_panel" => profiles[planet_index].solar_power_multiplier,
        "geothermal_power_station" => profiles[planet_index].geothermal_multiplier,
        _ => profiles[planet_index].wind_multiplier,
    };
    let output = building.power_generation_kw * machine_count * multiplier;
    probe.base_generation_kw = output;
    probe.power_output_kw = Some(output);
    match building_id {
        "solar_panel" => probe.solar_generation_kw = output,
        "geothermal_power_station" => probe.geothermal_generation_kw = output,
        _ => probe.wind_generation_kw = output,
    }
    Ok(Some(probe))
}

fn apply_power_source_probe(probe: &PowerSourceProbe, grids: &mut [GridRuntime]) {
    let runtime = &mut grids[probe.planet_index * GRID_IDS.len() + probe.grid_index];
    runtime.has_power_source = true;
    runtime.generator_count += probe.generator_count;
    match probe.kind {
        PowerSourceKind::Ray => {
            runtime.base_generation_kw += probe.base_generation_kw;
            runtime.ray_generation_kw += probe.ray_generation_kw;
        }
        PowerSourceKind::Fuel => {
            runtime.fuel_electric_energy_mj += probe.fuel_electric_energy_mj;
            runtime.rated_fuel_generator_kw += probe.rated_fuel_generator_kw;
        }
        PowerSourceKind::Accumulator | PowerSourceKind::Exchanger => {
            runtime.stored_energy_mj += probe.stored_energy_mj;
            runtime.storage_capacity_mj += probe.storage_capacity_mj;
        }
        PowerSourceKind::Wind => {
            runtime.base_generation_kw += probe.base_generation_kw;
            runtime.wind_generation_kw += probe.wind_generation_kw;
        }
        PowerSourceKind::Solar => {
            runtime.base_generation_kw += probe.base_generation_kw;
            runtime.solar_generation_kw += probe.solar_generation_kw;
        }
        PowerSourceKind::Geothermal => {
            runtime.base_generation_kw += probe.base_generation_kw;
            runtime.geothermal_generation_kw += probe.geothermal_generation_kw;
        }
    }
    if let Some(candidate) = &probe.dispatch_candidate {
        runtime.dispatch_candidates.push(candidate.clone());
    }
    if let Some(candidate) = &probe.accumulator_charge_candidate {
        runtime
            .accumulator_charge_candidates
            .push(candidate.clone());
    }
    if let Some(candidate) = &probe.exchanger_charge_candidate {
        runtime.exchanger_charge_candidates.push(candidate.clone());
    }
    if let Some(output) = probe.power_output_kw {
        runtime
            .power_output_by_entity
            .insert(probe.entity_index, output);
    }
}

fn apply_static_renewable_power_probe(probe: StaticRenewablePowerProbe, grids: &mut [GridRuntime]) {
    let runtime = &mut grids[probe.planet_index * GRID_IDS.len() + probe.grid_index];
    runtime.has_power_source = true;
    runtime.generator_count += probe.generator_count;
    runtime.base_generation_kw += probe.output_kw;
    match probe.kind {
        PowerSourceKind::Wind => runtime.wind_generation_kw += probe.output_kw,
        PowerSourceKind::Solar => runtime.solar_generation_kw += probe.output_kw,
        PowerSourceKind::Geothermal => runtime.geothermal_generation_kw += probe.output_kw,
        PowerSourceKind::Ray
        | PowerSourceKind::Fuel
        | PowerSourceKind::Accumulator
        | PowerSourceKind::Exchanger => {
            unreachable!("dynamic power source entered the static renewable cache")
        }
    }
    runtime
        .power_output_by_entity
        .insert(probe.entity_index, probe.output_kw);
}

#[allow(clippy::too_many_arguments)]
fn collect_power_sources_with_runtime(
    deterministic_runtime: &DeterministicRuntime,
    state: &CoreState,
    entities: &[Value],
    reception: &crate::dyson::Reception,
    profiles: &[PlanetProfile],
    production_buffer_limit: f64,
    seconds: f64,
    power_probe_runtime: &mut std::sync::Arc<PowerProbeRuntime>,
    mode: PowerProbeMode,
    grids: &mut [GridRuntime],
) -> anyhow::Result<PreparedPowerSources> {
    let selection = power_probe_runtime.select(state, entities, profiles, mode);
    let settlement_entity_indices = selection
        .source_slots
        .iter()
        .map(|&source_slot| state.factory_topology.power_source_indices[source_slot])
        .collect::<Vec<_>>();
    let probed = collect_indexed_power_probes_with_runtime(
        deterministic_runtime,
        &selection.source_slots,
        |&source_slot| {
            let entity_index = state.factory_topology.power_source_indices[source_slot];
            probe_power_source(
                state,
                entities,
                reception,
                profiles,
                production_buffer_limit,
                seconds,
                entity_index,
            )
        },
    )
    .into_iter()
    .collect::<anyhow::Result<Vec<_>>>()?;
    #[cfg(test)]
    if mode == PowerProbeMode::IndexedFailAfterCollect {
        bail!("injected failure after power probe candidate collection");
    }

    if selection.scan.full_scan {
        if selection.source_slots.len() != state.factory_topology.power_source_indices.len()
            || selection
                .source_slots
                .iter()
                .copied()
                .ne(0..selection.source_slots.len())
        {
            bail!("native full power probe selection diverged");
        }
        for probe in probed.iter().flatten() {
            apply_power_source_probe(probe, grids);
        }
        std::sync::Arc::make_mut(power_probe_runtime).commit_full(
            &probed,
            profiles,
            selection.scan,
            mode,
        );
        #[cfg(test)]
        if mode == PowerProbeMode::IndexedFailAfterRuntimeMutation {
            bail!("injected failure after power probe runtime mutation");
        }
        return Ok(PreparedPowerSources {
            scan: selection.scan,
            settlement_entity_indices,
        });
    }

    if selection.source_slots.len() != probed.len() {
        bail!("native sparse power probe selection diverged");
    }
    let baseline = &power_probe_runtime.static_baseline;
    if baseline.len() != state.factory_topology.power_source_indices.len() {
        bail!("native sparse power probe baseline diverged");
    }
    // Validate the complete compact replay before mutating the candidate
    // grids. A malformed cache can only fail this candidate; it can never
    // partially publish power allocation or replace the committed runtime.
    let mut dynamic_slots = selection.source_slots.iter().copied().peekable();
    for source_slot in 0..baseline.len() {
        if dynamic_slots.peek().copied() == Some(source_slot) {
            dynamic_slots.next();
        } else if baseline[source_slot].is_none() {
            bail!("native sparse power probe cache is incomplete");
        }
    }
    if dynamic_slots.next().is_some() {
        bail!("native sparse power probe order diverged");
    }

    let mut dynamic = selection
        .source_slots
        .iter()
        .copied()
        .zip(probed.iter())
        .peekable();
    for (source_slot, static_probe) in baseline.iter().copied().enumerate() {
        if dynamic
            .peek()
            .is_some_and(|(dynamic_slot, _)| *dynamic_slot == source_slot)
        {
            let (_, probe) = dynamic
                .next()
                .expect("peeked dynamic power probe disappeared");
            if let Some(probe) = probe {
                apply_power_source_probe(probe, grids);
            }
        } else {
            apply_static_renewable_power_probe(
                static_probe.expect("validated static power probe disappeared"),
                grids,
            );
        }
    }
    if dynamic.next().is_some() {
        bail!("native sparse power probe replay diverged");
    }
    std::sync::Arc::make_mut(power_probe_runtime).commit_sparse(selection.scan);
    #[cfg(test)]
    if mode == PowerProbeMode::IndexedFailAfterRuntimeMutation {
        bail!("injected failure after power probe runtime mutation");
    }
    Ok(PreparedPowerSources {
        scan: selection.scan,
        settlement_entity_indices,
    })
}

struct PreparedPowerSources {
    scan: PowerProbeScan,
    /// Persisted-order rows whose runtime display/inventory fields can change
    /// in this step. Static renewables are present on cold/profile-reset/full
    /// passes and sleep on proven warm passes.
    settlement_entity_indices: Vec<usize>,
}

fn probe_ready_station_demand(
    state: &CoreState,
    entities: &[Value],
    power_demand_multiplier: f64,
    entity_index: usize,
) -> anyhow::Result<PowerDemandProbe> {
    let object = entities[entity_index]
        .as_object()
        .ok_or_else(|| anyhow!("native local station is not an object"))?;
    let planet_index = state.factory_topology.entity_planet_indices[entity_index];
    let grid_index = state.factory_topology.entity_grid_indices[entity_index];
    if planet_index == usize::MAX || grid_index == usize::MAX {
        bail!("native local station power topology is unknown");
    }
    let building = string_at(object, "buildingId")
        .and_then(|id| state.catalog.buildings.get(id))
        .ok_or_else(|| anyhow!("native local station building is missing"))?;
    let demand_kw = building.power_demand_kw
        * finite_number(object.get("machineCount"))
        * power_demand_multiplier;
    let priority = finite_number(object.get("powerPriority"))
        .floor()
        .clamp(1.0, 3.0) as usize;
    Ok(PowerDemandProbe {
        entity_index,
        planet_index,
        grid_index,
        demand_kw,
        priority,
        demand_active: true,
        zero_if_disconnected: true,
    })
}

fn probe_vein_demand(
    state: &CoreState,
    entities: &[Value],
    production_buffer_limit: f64,
    power_demand_multiplier: f64,
    entity_index: usize,
) -> anyhow::Result<Option<PowerDemandProbe>> {
    let object = entities[entity_index]
        .as_object()
        .ok_or_else(|| anyhow!("native simple factory entity is not an object"))?;
    let miner_count = finite_number(object.get("minerCount"));
    if miner_count <= 0.0 {
        return Ok(None);
    }
    let planet_index = state.factory_topology.entity_planet_indices[entity_index];
    let grid_index = state.factory_topology.entity_grid_indices[entity_index];
    if planet_index == usize::MAX || grid_index == usize::MAX {
        bail!("native simple factory vein power topology is unknown");
    }
    let resource = string_at(object, "resourceId").unwrap_or_default();
    let extractor = state
        .catalog
        .buildings
        .get(extractor_id(resource))
        .ok_or_else(|| anyhow!("native simple factory extractor catalog is missing"))?;
    let current = object
        .get("outputs")
        .and_then(Value::as_object)
        .and_then(|outputs| outputs.get(resource))
        .map(|value| finite_number(Some(value)))
        .unwrap_or(0.0);
    let capacity = stacked_capacity(
        extractor.output_capacity,
        miner_count,
        production_buffer_limit,
    );
    let demand_kw = extractor.power_demand_kw * miner_count * power_demand_multiplier;
    let priority = finite_number(object.get("powerPriority"))
        .floor()
        .clamp(1.0, 3.0) as usize;
    Ok(Some(PowerDemandProbe {
        entity_index,
        planet_index,
        grid_index,
        demand_kw,
        priority,
        demand_active: current < capacity - EPSILON,
        zero_if_disconnected: false,
    }))
}

#[allow(clippy::too_many_arguments)]
fn probe_machine_demand(
    state: &CoreState,
    base: &Map<String, Value>,
    entities: &[Value],
    profiles: &[PlanetProfile],
    production_buffer_limit: f64,
    power_demand_multiplier: f64,
    industrial_speed: f64,
    research_speed: f64,
    seconds: f64,
    entity_index: usize,
) -> anyhow::Result<Option<PowerDemandProbe>> {
    let object = entities[entity_index]
        .as_object()
        .ok_or_else(|| anyhow!("native simple factory entity is not an object"))?;
    let building_id = string_at(object, "buildingId").unwrap_or_default();
    let recipe_id = string_at(object, "recipeId").unwrap_or_default();
    let building = state
        .catalog
        .buildings
        .get(building_id)
        .ok_or_else(|| anyhow!("native simple factory machine building is missing"))?;
    let recipe = state
        .catalog
        .recipes
        .get(recipe_id)
        .ok_or_else(|| anyhow!("native simple factory machine recipe is missing"))?;
    if !machine_can_run(
        state,
        base,
        object,
        building,
        recipe,
        production_buffer_limit,
    ) {
        return Ok(None);
    }
    let planet_index = state.factory_topology.entity_planet_indices[entity_index];
    let grid_index = state.factory_topology.entity_grid_indices[entity_index];
    if planet_index == usize::MAX || grid_index == usize::MAX {
        bail!("native simple factory machine power topology is unknown");
    }
    let planet_speed = if specialization_applies(profiles[planet_index], building) {
        profiles[planet_index].production_speed_multiplier
    } else {
        1.0
    };
    let demand_kw = building.power_demand_kw
        * finite_number(object.get("machineCount"))
        * proliferator_power_multiplier_for_step(
            state,
            object,
            building,
            recipe,
            planet_speed,
            if recipe.id == "matrix_research" {
                research_speed
            } else {
                industrial_speed
            },
            seconds,
        )
        * power_demand_multiplier;
    let priority = finite_number(object.get("powerPriority"))
        .floor()
        .clamp(1.0, 3.0) as usize;
    Ok(Some(PowerDemandProbe {
        entity_index,
        planet_index,
        grid_index,
        demand_kw,
        priority,
        demand_active: true,
        zero_if_disconnected: true,
    }))
}

struct PreparedPowerDemandProbes {
    ready_stations: Vec<anyhow::Result<PowerDemandProbe>>,
    veins: Vec<anyhow::Result<Option<PowerDemandProbe>>>,
    machines: Vec<anyhow::Result<Option<PowerDemandProbe>>>,
    scheduler: PartitionedPrepareDiagnostics,
}

/// Captures three independent power-demand domains into owned event buffers.
/// No grid, entity or CoreState field is written here. The caller validates
/// the buffers in ready-station -> vein -> machine order and only then replays
/// them into the candidate grid, retaining the historical error and floating-
/// point accumulation order regardless of worker scheduling.
#[allow(clippy::too_many_arguments)]
fn prepare_power_demand_probes_with_runtime(
    runtime: &DeterministicRuntime,
    state: &CoreState,
    base: &Map<String, Value>,
    entities: &[Value],
    profiles: &[PlanetProfile],
    ready_station_indices: &[usize],
    vein_indices: &[usize],
    machine_indices: &[usize],
    production_buffer_limit: f64,
    power_demand_multiplier: f64,
    industrial_speed: f64,
    research_speed: f64,
    seconds: f64,
) -> PreparedPowerDemandProbes {
    let active_mask = u8::from(!ready_station_indices.is_empty())
        | (u8::from(!vein_indices.is_empty()) << 1)
        | (u8::from(!machine_indices.is_empty()) << 2);
    let work_items = ready_station_indices
        .len()
        .saturating_add(vein_indices.len())
        .saturating_add(machine_indices.len());
    let ((ready_stations, veins, machines, ()), scheduler) = runtime.partitioned_prepare4(
        active_mask,
        work_items,
        || {
            collect_indexed_power_probes_with_runtime(
                runtime,
                ready_station_indices,
                |&entity_index| {
                    probe_ready_station_demand(
                        state,
                        entities,
                        power_demand_multiplier,
                        entity_index,
                    )
                },
            )
        },
        || {
            collect_indexed_power_probes_with_runtime(runtime, vein_indices, |&entity_index| {
                probe_vein_demand(
                    state,
                    entities,
                    production_buffer_limit,
                    power_demand_multiplier,
                    entity_index,
                )
            })
        },
        || {
            collect_indexed_power_probes_with_runtime(runtime, machine_indices, |&entity_index| {
                probe_machine_demand(
                    state,
                    base,
                    entities,
                    profiles,
                    production_buffer_limit,
                    power_demand_multiplier,
                    industrial_speed,
                    research_speed,
                    seconds,
                    entity_index,
                )
            })
        },
        || (),
    );
    PreparedPowerDemandProbes {
        ready_stations,
        veins,
        machines,
        scheduler,
    }
}

fn apply_power_demand_probe(
    probe: PowerDemandProbe,
    grids: &mut [GridRuntime],
    disconnected_power_factor_indices: &mut Vec<usize>,
) {
    let runtime = &mut grids[probe.planet_index * GRID_IDS.len() + probe.grid_index];
    if runtime.has_power_source {
        runtime.connected_entities += 1;
        if probe.demand_active {
            runtime.consumers[probe.priority].push(Consumer {
                entity_index: probe.entity_index,
                demand_kw: probe.demand_kw,
            });
        }
    } else {
        runtime.disconnected_entities += 1;
        if probe.demand_active {
            runtime.disconnected_demand_kw += probe.demand_kw;
            if probe.zero_if_disconnected {
                disconnected_power_factor_indices.push(probe.entity_index);
            }
        }
    }
}

fn construction_power_aggregation_is_exact(
    probe_sets: &[&[PowerDemandProbe]],
    groups: &[crate::construction::ConstructionPowerGroupDemand],
    grid_count: usize,
) -> bool {
    let mut totals = vec![0.0; grid_count];
    for probe in probe_sets.iter().flat_map(|probes| probes.iter()) {
        if !probe.demand_active {
            continue;
        }
        let Some(slot) = probe
            .planet_index
            .checked_mul(GRID_IDS.len())
            .and_then(|slot| slot.checked_add(probe.grid_index))
            .filter(|&slot| slot < grid_count)
        else {
            return false;
        };
        let next = totals[slot] + probe.demand_kw;
        if !crate::construction::nonnegative_safe_integer(probe.demand_kw)
            || !crate::construction::nonnegative_safe_integer(next)
        {
            return false;
        }
        totals[slot] = next;
    }
    for group in groups {
        let Some(slot) = group
            .planet_index
            .checked_mul(GRID_IDS.len())
            .and_then(|slot| slot.checked_add(group.grid_index))
            .filter(|&slot| slot < grid_count)
        else {
            return false;
        };
        if !(1..=3).contains(&group.priority) || group.center_count == 0 {
            return false;
        }
        let next = totals[slot] + group.demand_kw;
        if !crate::construction::nonnegative_safe_integer(group.demand_kw)
            || !crate::construction::nonnegative_safe_integer(next)
        {
            return false;
        }
        totals[slot] = next;
    }
    true
}

fn apply_construction_power_group(
    group: crate::construction::ConstructionPowerGroupDemand,
    grids: &mut [GridRuntime],
    disconnected_power_factor_indices: &mut Vec<usize>,
) {
    let runtime = &mut grids[group.planet_index * GRID_IDS.len() + group.grid_index];
    let center_count = group.center_count as u64;
    if runtime.has_power_source {
        runtime.connected_entities += center_count;
        runtime.consumers[group.priority].push(Consumer {
            entity_index: group.representative_entity_index,
            demand_kw: group.demand_kw,
        });
    } else {
        runtime.disconnected_entities += center_count;
        runtime.disconnected_demand_kw += group.demand_kw;
        disconnected_power_factor_indices.push(group.representative_entity_index);
    }
}

fn static_admission_reason_with_records(
    state: &CoreState,
    parsed_entities: Option<&[Value]>,
) -> anyhow::Result<Option<&'static str>> {
    if parsed_entities.is_some_and(|entities| entities.len() != state.entity_index.len()) {
        bail!("native factory admission entity topology changed");
    }
    if crate::campaign::validate_state(state.base_value()).is_err() {
        return Ok(Some("campaign-state-invalid"));
    }
    if let Some(reason) = crate::global_progress::admission_reason(state)? {
        return Ok(Some(reason));
    }
    if let Some(reason) = crate::galactic_exports::admission_reason(state)? {
        return Ok(Some(reason));
    }
    if let Some(reason) = crate::speedrun::admission_reason(state)? {
        return Ok(Some(reason));
    }
    if state.entity_index.is_empty() {
        return Ok(Some("simple-factory-is-empty"));
    }
    let planet_ids = state
        .catalog
        .planets
        .iter()
        .map(|planet| planet.id.as_str())
        .collect::<HashSet<_>>();
    for index in 0..state.entity_index.len() {
        let decoded;
        let entity = if let Some(entities) = parsed_entities {
            &entities[index]
        } else {
            decoded = state.parse_entity(index)?;
            &decoded
        };
        let object = entity
            .as_object()
            .ok_or_else(|| anyhow!("native simple factory entity is not an object"))?;
        if !string_at(object, "planetId").is_some_and(|id| planet_ids.contains(id))
            || grid_index(object).is_none()
        {
            return Ok(Some("simple-factory-entity-location-invalid"));
        }
        match string_at(object, "kind") {
            Some("vein") => {
                let Some(resource) = string_at(object, "resourceId") else {
                    return Ok(Some("simple-factory-vein-resource-missing"));
                };
                let Some(kind) = state
                    .catalog
                    .items
                    .get(resource)
                    .map(|item| item.kind.as_str())
                else {
                    return Ok(Some("simple-factory-vein-resource-missing"));
                };
                if !matches!(kind, "solid" | "fluid") {
                    return Ok(Some("simple-factory-vein-resource-unsupported"));
                }
                let extractor = match resource {
                    "crude_oil" => "oil_extractor",
                    "water" | "sulfuric_acid" => "water_pump",
                    _ => "mining_machine",
                };
                if string_at(object, "extractorBuildingId")
                    .is_some_and(|building| building != extractor)
                    || !state.catalog.buildings.contains_key(extractor)
                {
                    return Ok(Some("simple-factory-extractor-unsupported"));
                }
            }
            Some("power") => {
                let building = string_at(object, "buildingId").unwrap_or_default();
                if !matches!(
                    building,
                    "wind_turbine"
                        | "solar_panel"
                        | "geothermal_power_station"
                        | "thermal_power_plant"
                        | "mini_fusion_power_plant"
                        | "artificial_star"
                        | "accumulator"
                        | "energy_exchanger"
                ) || !state.catalog.buildings.contains_key(building)
                {
                    return Ok(Some("simple-factory-power-source-unsupported"));
                }
                if is_fuel_generator(building)
                    && string_at(object, "fuelItemId").is_some_and(|fuel| {
                        state
                            .catalog
                            .buildings
                            .get(building)
                            .is_none_or(|definition| {
                                !definition.fuel_item_ids.iter().any(|id| id == fuel)
                            })
                    })
                {
                    return Ok(Some("simple-factory-fuel-invalid"));
                }
                if building == "energy_exchanger"
                    && !matches!(
                        string_at(object, "energyMode"),
                        Some("charge" | "discharge")
                    )
                {
                    return Ok(Some("simple-factory-energy-mode-invalid"));
                }
            }
            Some("machine") => {
                let building_id = string_at(object, "buildingId").unwrap_or_default();
                let recipe_id = string_at(object, "recipeId").unwrap_or_default();
                let Some(building) = state.catalog.buildings.get(building_id) else {
                    return Ok(Some("simple-factory-machine-building-missing"));
                };
                if matches!(
                    building_id,
                    "construction_center"
                        | "time_warp_device"
                        | "micro_black_hole_connector"
                        | "galactic_material_exporter"
                ) {
                    if building.kind != "machine" {
                        return Ok(Some("simple-factory-machine-feature-unsupported"));
                    }
                    continue;
                }
                let Some(recipe) = state.catalog.recipes.get(recipe_id) else {
                    return Ok(Some("simple-factory-machine-recipe-missing"));
                };
                let supported_dyson_machine = matches!(
                    (building_id, recipe_id),
                    ("ray_receiver", "ray_power" | "critical_photon")
                        | ("em_rail_ejector", "solar_sail_launch")
                        | ("vertical_launching_silo", "carrier_rocket_launch")
                );
                if building.kind != "machine"
                    || matches!(
                        building_id,
                        "ray_receiver" | "em_rail_ejector" | "vertical_launching_silo"
                    ) && !supported_dyson_machine
                    || recipe_id != "matrix_research"
                        && !supported_dyson_machine
                        && (recipe.inputs.is_empty() || recipe.outputs.is_empty())
                {
                    return Ok(Some("simple-factory-machine-feature-unsupported"));
                }
                if bool_at(Some(entity), &["sprayCoaterInstalled"])
                    && (object
                        .get("proliferatorTier")
                        .and_then(Value::as_u64)
                        .and_then(|tier| u8::try_from(tier).ok())
                        .is_none_or(|tier| !state.catalog.proliferators.contains_key(&tier))
                        || !matches!(
                            string_at(object, "proliferatorMode"),
                            Some("normal" | "extra" | "speed")
                        ))
                {
                    return Ok(Some("simple-factory-proliferator-invalid"));
                }
            }
            Some("storage" | "splitter") => {
                let building_id = string_at(object, "buildingId").unwrap_or_default();
                let Some(building) = state.catalog.buildings.get(building_id) else {
                    return Ok(Some("simple-factory-logistics-building-missing"));
                };
                if building.kind != string_at(object, "kind").unwrap_or_default()
                    || object
                        .get("storedItemId")
                        .and_then(Value::as_str)
                        .is_some_and(|id| !state.catalog.items.contains_key(id))
                    || string_at(object, "kind") == Some("splitter")
                        && !matches!(
                            string_at(object, "distributionMode"),
                            Some("balanced" | "priority")
                        )
                {
                    return Ok(Some("simple-factory-logistics-entity-invalid"));
                }
            }
            Some("station") => {}
            _ => return Ok(Some("simple-factory-entity-kind-unsupported")),
        }
    }
    let base = state.base_value();
    if let Some(research) = base.get("research").and_then(Value::as_object) {
        let selected_invalid = research
            .get("selectedTechId")
            .and_then(Value::as_str)
            .is_some_and(|id| !state.catalog.technologies.contains_key(id));
        let queue_invalid = research
            .get("queuedTechIds")
            .and_then(Value::as_array)
            .is_none_or(|ids| {
                ids.iter().any(|id| {
                    id.as_str()
                        .is_none_or(|id| !state.catalog.technologies.contains_key(id))
                })
            });
        if selected_invalid || queue_invalid {
            return Ok(Some("simple-factory-research-catalog-invalid"));
        }
    }
    if let Some(infinite_id) = active_infinite_research_id(base)
        && (!crate::infinite_research::valid_id(infinite_id) || !endgame_unlocked(base))
    {
        return Ok(Some("simple-factory-infinite-research-invalid"));
    }
    let profiles = base
        .get("galaxy")
        .and_then(Value::as_object)
        .and_then(|value| value.get("profiles"))
        .and_then(Value::as_object);
    let planet_metrics = base.get("planetMetrics").and_then(Value::as_object);
    let grid_metrics = base.get("powerGridMetrics").and_then(Value::as_object);
    if state.catalog.planets.iter().any(|planet| {
        profiles.is_none_or(|values| !values.contains_key(&planet.id))
            || planet_metrics.is_none_or(|values| !values.contains_key(&planet.id))
            || grid_metrics.is_none_or(|values| !values.contains_key(&planet.id))
    }) {
        return Ok(Some("simple-factory-planet-directory-incomplete"));
    }
    if let Some(reason) = crate::orbital_station::admission_reason(state)? {
        return Ok(Some(reason));
    }
    if let Some(reason) = crate::system_space_station::admission_reason(state)? {
        return Ok(Some(reason));
    }
    let belt_reason = if let Some(entities) = parsed_entities {
        crate::belts::admission_reason_with_entities(state, entities)?
    } else {
        crate::belts::admission_reason(state)?
    };
    if let Some(reason) = belt_reason {
        return Ok(Some(reason));
    }
    if let Some(reason) = crate::dyson::admission_reason(state)? {
        return Ok(Some(reason));
    }
    if let Some(reason) = crate::local_logistics::admission_reason(state)? {
        return Ok(Some(reason));
    }
    if let Some(reason) = crate::quantum_logistics::admission_reason(state)? {
        return Ok(Some(reason));
    }
    if let Some(reason) = crate::interstellar_logistics::admission_reason(state)? {
        return Ok(Some(reason));
    }
    Ok(None)
}

pub(crate) fn static_admission_reason(state: &CoreState) -> anyhow::Result<Option<&'static str>> {
    static_admission_reason_with_records(state, None)
}

pub(crate) fn static_admission_reason_with_entities(
    state: &CoreState,
    entities: &[Value],
) -> anyhow::Result<Option<&'static str>> {
    static_admission_reason_with_records(state, Some(entities))
}

pub(crate) fn admission_reason(state: &CoreState) -> anyhow::Result<Option<&'static str>> {
    let Some(static_reason) = state.factory_static_admission_reason() else {
        bail!("native factory static admission was not prepared");
    };
    if static_reason.is_some() {
        return Ok(static_reason);
    }
    crate::construction::admission_reason(state)
}

fn set_number(object: &mut Map<String, Value>, key: &str, value: f64) -> anyhow::Result<()> {
    let value = Value::Number(
        Number::from_f64(value)
            .ok_or_else(|| anyhow!("native simple factory produced a non-finite number"))?,
    );
    if let Some(target) = object.get_mut(key) {
        *target = value;
    } else {
        object.insert(key.to_owned(), value);
    }
    Ok(())
}

fn set_machine_item_number(values: &mut Map<String, Value>, item_id: &str, value: f64) {
    let value = Number::from_f64(value)
        .map(Value::Number)
        .unwrap_or(Value::from(0));
    if let Some(target) = values.get_mut(item_id) {
        *target = value;
    } else {
        values.insert(item_id.to_owned(), value);
    }
}

fn profile_for(
    base: &Map<String, Value>,
    planet_id: &str,
    system_id: &str,
) -> anyhow::Result<PlanetProfile> {
    let profile = base
        .get("galaxy")
        .and_then(Value::as_object)
        .and_then(|value| value.get("profiles"))
        .and_then(Value::as_object)
        .and_then(|profiles| profiles.get(planet_id))
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native simple factory planet profile is missing"))?;
    let luminosity = base
        .get("galaxy")
        .and_then(Value::as_object)
        .and_then(|value| value.get("systemProfiles"))
        .and_then(Value::as_object)
        .and_then(|profiles| profiles.get(system_id))
        .and_then(Value::as_object)
        .map(|profile| finite_number(profile.get("luminosity")))
        .ok_or_else(|| anyhow!("native simple factory star-system profile is missing"))?;
    let solar_multiplier = finite_number(profile.get("solarMultiplier"));
    let tidal_bonus = if profile
        .get("tidalLocked")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        1.25
    } else {
        1.0
    };
    let specialization = match profile
        .get("specialization")
        .and_then(Value::as_str)
        .unwrap_or("balanced")
    {
        "smelting" => "smelting",
        "chemical" => "chemical",
        "research" => "research",
        "particle" => "particle",
        "logistics" => "logistics",
        _ => "balanced",
    };
    let ocean_type = match profile
        .get("oceanType")
        .and_then(Value::as_str)
        .unwrap_or("none")
    {
        "water" => "water",
        "sulfuric-acid" => "sulfuric-acid",
        _ => "none",
    };
    Ok(PlanetProfile {
        wind_multiplier: finite_number(profile.get("windMultiplier")),
        solar_power_multiplier: rounded(solar_multiplier * luminosity * tidal_bonus, 2),
        geothermal_multiplier: finite_number(profile.get("geothermalMultiplier")),
        mining_multiplier: finite_number(profile.get("miningMultiplier")),
        production_speed_multiplier: finite_number(profile.get("productionSpeedMultiplier")),
        specialization,
        ocean_type,
    })
}

fn extractor_id(resource: &str) -> &'static str {
    match resource {
        "crude_oil" => "oil_extractor",
        "water" | "sulfuric_acid" => "water_pump",
        _ => "mining_machine",
    }
}

fn vein_is_infinite(
    resource: &str,
    item_kind: &str,
    profile: PlanetProfile,
    infinite_resource_mode: bool,
    solid_consumption_tenths: f64,
) -> bool {
    infinite_resource_mode
        || item_kind == "solid" && solid_consumption_tenths <= 0.0
        || resource == "water" && profile.ocean_type == "water"
        || resource == "sulfuric_acid" && profile.ocean_type == "sulfuric-acid"
}

fn probe_vein_settlement(
    environment: &VeinProbeEnvironment<'_>,
    entity_index: usize,
) -> anyhow::Result<VeinSettlementDelta> {
    let object = environment.entities[entity_index]
        .as_object()
        .ok_or_else(|| anyhow!("native simple factory entity is not an object"))?;
    let planet = environment.state.factory_topology.entity_planet_indices[entity_index];
    let grid = environment.state.factory_topology.entity_grid_indices[entity_index];
    if planet == usize::MAX || grid == usize::MAX {
        bail!("native simple factory entity topology is unknown");
    }
    let miner_count = finite_number(object.get("minerCount"));
    if miner_count <= 0.0 {
        return Ok(VeinSettlementDelta::Noop);
    }
    let power_factor = if environment.grids[planet * GRID_IDS.len() + grid].has_power_source {
        environment
            .power_factors
            .get(&entity_index)
            .copied()
            .unwrap_or(1.0)
    } else {
        0.0
    };
    let resource = string_at(object, "resourceId")
        .ok_or_else(|| anyhow!("native simple factory vein resource is missing"))?
        .to_owned();
    let extractor = environment
        .state
        .catalog
        .buildings
        .get(extractor_id(&resource))
        .ok_or_else(|| anyhow!("native simple factory extractor catalog is missing"))?;
    let item_kind = environment
        .state
        .catalog
        .items
        .get(&resource)
        .map(|item| item.kind.as_str())
        .ok_or_else(|| anyhow!("native simple factory vein item catalog is missing"))?;
    let previous_progress = finite_number(object.get("progress"));
    let current = object
        .get("outputs")
        .and_then(Value::as_object)
        .and_then(|outputs| outputs.get(&resource))
        .map(|value| finite_number(Some(value)))
        .unwrap_or(0.0)
        .floor();
    let capacity = stacked_capacity(
        extractor.output_capacity,
        miner_count,
        environment.context.production_buffer_limit,
    );
    let entity_id = string_at(object, "id").unwrap_or_default();
    let free = (capacity - current).max(0.0)
        + crate::belts::output_credit(
            environment.state,
            environment.output_credits,
            entity_id,
            &resource,
        );
    let remaining_resource = finite_number(object.get("resourceRemaining"))
        .floor()
        .max(0.0);
    let depletion_remainder = finite_number(object.get("resourceDepletionRemainder"))
        .floor()
        .clamp(0.0, 9.0);
    let consumption_tenths = if item_kind == "solid" {
        environment.context.finite_consumption_tenths
    } else {
        10.0
    };
    let infinite = vein_is_infinite(
        &resource,
        item_kind,
        environment.profiles[planet],
        environment.context.infinite_resource_mode,
        environment.context.finite_consumption_tenths,
    );
    let output_allowance = if infinite {
        f64::INFINITY
    } else {
        ((remaining_resource * 10.0 - depletion_remainder).max(0.0) / consumption_tenths).floor()
    };
    if free < 1.0 || power_factor <= EPSILON || output_allowance < 1.0 {
        return Ok(VeinSettlementDelta::Idle { power_factor });
    }
    let mining_speed = (if item_kind == "solid" {
        environment.context.mining_research_multiplier
    } else {
        1.0 + environment.context.vein_level * 0.1
    }) * environment.profiles[planet].mining_multiplier;
    let progress = rounded(
        previous_progress
            + extractor.speed
                * mining_speed
                * miner_count
                * environment.context.seconds
                * power_factor,
        4,
    );
    let produced = free.min(output_allowance).min((progress + EPSILON).floor());
    if object.get("outputs").and_then(Value::as_object).is_none() {
        bail!("native simple factory vein outputs are missing");
    }
    let finite_resource = (!infinite).then(|| {
        let accrued = depletion_remainder + produced.floor().max(0.0) * consumption_tenths;
        let depleted = remaining_resource.min((accrued / 10.0).floor());
        (remaining_resource - depleted, accrued - depleted * 10.0)
    });
    Ok(VeinSettlementDelta::Active {
        resource,
        power_factor,
        output_amount: current + produced,
        finite_resource,
        progress: if produced >= free {
            0.0
        } else {
            rounded(progress - produced, 4)
        },
        production_rate: rounded(
            extractor.speed * mining_speed * miner_count * power_factor * 60.0,
            2,
        ),
        produced,
    })
}

fn collect_vein_settlement_outcomes_with_runtime<F>(
    runtime: &DeterministicRuntime,
    entity_indices: &[usize],
    probe: F,
) -> Vec<VeinSettlementOutcome>
where
    F: Fn(usize) -> anyhow::Result<VeinSettlementDelta> + Send + Sync,
{
    runtime.indexed_map(entity_indices, |_, entity_index| VeinSettlementOutcome {
        entity_index: *entity_index,
        result: probe(*entity_index),
    })
}

fn collect_vein_settlement_outcomes(
    runtime: &DeterministicRuntime,
    entity_indices: &[usize],
    environment: &VeinProbeEnvironment<'_>,
) -> Vec<VeinSettlementOutcome> {
    collect_vein_settlement_outcomes_with_runtime(runtime, entity_indices, |entity_index| {
        probe_vein_settlement(environment, entity_index)
    })
}

fn replay_vein_settlement(
    entity: &mut Value,
    delta: VeinSettlementDelta,
) -> anyhow::Result<Option<(String, f64)>> {
    let object = entity_object(entity)?;
    match delta {
        VeinSettlementDelta::Noop => Ok(None),
        VeinSettlementDelta::Idle { power_factor } => {
            set_number(object, "powerFactor", rounded(power_factor, 4))?;
            set_number(object, "progress", 0.0)?;
            set_number(object, "utilization", 0.0)?;
            set_number(object, "productionRate", 0.0)?;
            Ok(None)
        }
        VeinSettlementDelta::Active {
            resource,
            power_factor,
            output_amount,
            finite_resource,
            progress,
            production_rate,
            produced,
        } => {
            set_number(object, "powerFactor", rounded(power_factor, 4))?;
            object
                .get_mut("outputs")
                .and_then(Value::as_object_mut)
                .ok_or_else(|| anyhow!("native simple factory vein outputs are missing"))?
                .insert(
                    resource.clone(),
                    Number::from_f64(output_amount)
                        .map(Value::Number)
                        .unwrap_or(Value::from(0)),
                );
            if let Some((remaining, remainder)) = finite_resource {
                set_number(object, "resourceRemaining", remaining)?;
                set_number(object, "resourceDepletionRemainder", remainder)?;
            }
            set_number(object, "progress", progress)?;
            set_number(object, "utilization", power_factor)?;
            set_number(object, "productionRate", production_rate)?;
            Ok(Some((resource, produced)))
        }
    }
}

fn specialization_applies(profile: PlanetProfile, building: &BuildingDefinition) -> bool {
    match profile.specialization {
        "balanced" => true,
        "smelting" => building.family.as_deref() == Some("smelter"),
        "chemical" => building.family.as_deref() == Some("chemical"),
        "research" => building.id == "matrix_lab",
        "particle" => {
            matches!(
                building.id.as_str(),
                "miniature_particle_collider" | "fractionator"
            )
        }
        _ => building.id == "orbital_collector" || building.id.contains("logistics_station"),
    }
}

fn completed_tech(base: &Map<String, Value>, id: &str) -> bool {
    base.get("research")
        .and_then(Value::as_object)
        .and_then(|value| value.get("completedTechIds"))
        .and_then(Value::as_array)
        .is_some_and(|values| values.iter().any(|value| value.as_str() == Some(id)))
}

fn vein_utilization_level(base: &Map<String, Value>) -> f64 {
    number_at(
        base.get("endgame"),
        &["infiniteResearch", "vein_utilization", "level"],
    )
    .floor()
    .clamp(0.0, 1_000.0)
}

fn difficulty_multipliers(base: &Map<String, Value>) -> (f64, f64) {
    match base
        .get("settings")
        .and_then(Value::as_object)
        .and_then(|value| value.get("difficulty"))
        .and_then(Value::as_str)
        .unwrap_or("standard")
    {
        "relaxed" => (1.15, 0.9),
        "hard" => (0.85, 1.2),
        _ => (1.0, 1.0),
    }
}

fn industrial_speed_multiplier(base: &Map<String, Value>) -> f64 {
    let level = number_at(
        base.get("endgame"),
        &["infiniteResearch", "matrix_compression", "level"],
    )
    .floor()
    .clamp(0.0, 1_000.0);
    let difficulty = match base
        .get("settings")
        .and_then(Value::as_object)
        .and_then(|value| value.get("difficulty"))
        .and_then(Value::as_str)
        .unwrap_or("standard")
    {
        "relaxed" => 1.15,
        "hard" => 0.85,
        _ => 1.0,
    };
    (1.0 + level * 0.04) * difficulty
}

fn research_speed_multiplier(base: &Map<String, Value>) -> f64 {
    let finite_bonus = ["research_speed_1", "research_speed_2", "research_speed_3"]
        .iter()
        .filter(|id| completed_tech(base, id))
        .count() as f64
        * 0.25;
    let compression = number_at(
        base.get("endgame"),
        &["infiniteResearch", "matrix_compression", "level"],
    )
    .floor()
    .clamp(0.0, 1_000.0);
    let difficulty = match base
        .get("settings")
        .and_then(Value::as_object)
        .and_then(|value| value.get("difficulty"))
        .and_then(Value::as_str)
        .unwrap_or("standard")
    {
        "relaxed" => 1.15,
        "hard" => 0.85,
        _ => 1.0,
    };
    (1.0 + finite_bonus) * (1.0 + compression * 0.1) * difficulty
}

fn recipe_technology_available(base: &Map<String, Value>, recipe: &RecipeDefinition) -> bool {
    recipe
        .required_tech_id
        .as_deref()
        .is_none_or(|id| completed_tech(base, id))
}

fn proliferator_tier(entity: &Map<String, Value>) -> Option<u8> {
    entity
        .get("proliferatorTier")
        .and_then(Value::as_u64)
        .and_then(|value| u8::try_from(value).ok())
}

fn proliferator_applies(entity: &Map<String, Value>, recipe: &RecipeDefinition) -> bool {
    entity.get("sprayCoaterInstalled").and_then(Value::as_bool) == Some(true)
        && proliferator_tier(entity).is_some()
        && matches!(
            string_at(entity, "proliferatorMode"),
            Some("extra" | "speed")
        )
        && (if recipe.id == "matrix_research" {
            string_at(entity, "proliferatorMode") == Some("speed")
        } else {
            !recipe.inputs.is_empty() && !recipe.outputs.is_empty()
        })
}

fn proliferator_spray_cost(recipe: &RecipeDefinition) -> f64 {
    recipe
        .inputs
        .iter()
        .map(|input| input.amount)
        .sum::<f64>()
        .max(1.0)
}

fn available_full_proliferator_cycles(
    state: &CoreState,
    entity: &Map<String, Value>,
    recipe: &RecipeDefinition,
) -> f64 {
    if !proliferator_applies(entity, recipe) {
        return 0.0;
    }
    let Some(definition) =
        proliferator_tier(entity).and_then(|tier| state.catalog.proliferators.get(&tier))
    else {
        return 0.0;
    };
    let points = finite_number(entity.get("proliferatorPoints")).max(0.0)
        + entity
            .get("inputs")
            .and_then(Value::as_object)
            .and_then(|inputs| inputs.get(&definition.item_id))
            .map(|value| (finite_number(Some(value)) + EPSILON).floor())
            .unwrap_or(0.0)
            * definition.spray_points;
    (points / proliferator_spray_cost(recipe) + EPSILON)
        .floor()
        .max(0.0)
}

fn proliferator_extra_bonus(
    state: &CoreState,
    entity: &Map<String, Value>,
    recipe: &RecipeDefinition,
) -> f64 {
    if !proliferator_applies(entity, recipe)
        || string_at(entity, "proliferatorMode") != Some("extra")
    {
        return 0.0;
    }
    proliferator_tier(entity)
        .and_then(|tier| state.catalog.proliferators.get(&tier))
        .map(|definition| definition.extra_product_bonus)
        .unwrap_or(0.0)
}

pub(crate) fn next_proliferated_output_bonus(
    state: &CoreState,
    entity: &Map<String, Value>,
    recipe: &RecipeDefinition,
    item_id: &str,
    output_amount: f64,
) -> f64 {
    if available_full_proliferator_cycles(state, entity, recipe) < 1.0 {
        return 0.0;
    }
    let progress = entity
        .get("proliferatorBonusProgress")
        .and_then(Value::as_object)
        .and_then(|values| values.get(item_id))
        .map(|value| finite_number(Some(value)))
        .unwrap_or(0.0);
    (progress + output_amount * proliferator_extra_bonus(state, entity, recipe) + EPSILON)
        .floor()
        .max(0.0)
}

fn proliferator_speed_multiplier(
    state: &CoreState,
    entity: &Map<String, Value>,
    recipe: &RecipeDefinition,
) -> f64 {
    if !proliferator_applies(entity, recipe)
        || string_at(entity, "proliferatorMode") != Some("speed")
    {
        return 1.0;
    }
    proliferator_tier(entity)
        .and_then(|tier| state.catalog.proliferators.get(&tier))
        .map(|definition| 1.0 + definition.speed_bonus)
        .unwrap_or(1.0)
}

fn proliferator_power_multiplier_for_step(
    state: &CoreState,
    entity: &Map<String, Value>,
    building: &BuildingDefinition,
    recipe: &RecipeDefinition,
    planet_speed: f64,
    recipe_speed: f64,
    seconds: f64,
) -> f64 {
    if !proliferator_applies(entity, recipe) {
        return 1.0;
    }
    let sprayed_cycles = available_full_proliferator_cycles(state, entity, recipe);
    if sprayed_cycles < 1.0 {
        return 1.0;
    }
    let base_cycles_per_second =
        building.speed * finite_number(entity.get("machineCount")) * recipe_speed * planet_speed
            / recipe.duration;
    if base_cycles_per_second <= EPSILON || seconds <= EPSILON {
        return 1.0;
    }
    let speed_multiplier = proliferator_speed_multiplier(state, entity, recipe);
    let accelerated_work = (sprayed_cycles - finite_number(entity.get("progress"))).max(0.0);
    let sprayed_seconds =
        accelerated_work / (base_cycles_per_second * speed_multiplier).max(EPSILON);
    let sprayed_fraction = (sprayed_seconds / seconds).min(1.0);
    let power_multiplier = proliferator_tier(entity)
        .and_then(|tier| state.catalog.proliferators.get(&tier))
        .map(|definition| definition.power_multiplier)
        .unwrap_or(1.0);
    1.0 + (power_multiplier - 1.0) * sprayed_fraction
}

fn consume_proliferator_points(
    state: &CoreState,
    entity: &mut Map<String, Value>,
    recipe: &RecipeDefinition,
    cycles: f64,
) -> anyhow::Result<()> {
    if !proliferator_applies(entity, recipe) || cycles < 1.0 {
        return Ok(());
    }
    let definition = proliferator_tier(entity)
        .and_then(|tier| state.catalog.proliferators.get(&tier))
        .ok_or_else(|| anyhow!("native proliferator definition is missing"))?;
    let required_points = proliferator_spray_cost(recipe) * cycles;
    let mut points = finite_number(entity.get("proliferatorPoints")).max(0.0);
    if points < required_points {
        let required_items = ((required_points - points) / definition.spray_points).ceil();
        let inputs = entity
            .get_mut("inputs")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native proliferator inputs are missing"))?;
        let available = inputs
            .get(&definition.item_id)
            .map(|value| (finite_number(Some(value)) + EPSILON).floor())
            .unwrap_or(0.0);
        let consumed = required_items.min(available);
        inputs.insert(
            definition.item_id.clone(),
            Number::from_f64(available - consumed)
                .map(Value::Number)
                .unwrap_or(Value::from(0)),
        );
        points += consumed * definition.spray_points;
    }
    set_number(
        entity,
        "proliferatorPoints",
        (points - required_points).max(0.0),
    )
}

fn selected_technology_id(base: &Map<String, Value>) -> Option<&str> {
    base.get("research")
        .and_then(Value::as_object)
        .and_then(|research| research.get("selectedTechId"))
        .and_then(Value::as_str)
}

fn active_infinite_research_id(base: &Map<String, Value>) -> Option<&str> {
    base.get("endgame")
        .and_then(Value::as_object)
        .and_then(|endgame| endgame.get("activeInfiniteResearchId"))
        .and_then(Value::as_str)
}

fn endgame_unlocked(base: &Map<String, Value>) -> bool {
    completed_tech(base, "universe_matrix")
}

pub(crate) fn has_active_research(base: &Map<String, Value>) -> bool {
    selected_technology_id(base).is_some()
        || active_infinite_research_id(base).is_some() && endgame_unlocked(base)
}

pub(crate) fn remaining_research_costs(
    state: &CoreState,
    base: &Map<String, Value>,
) -> Vec<(String, f64)> {
    if let Some((technology_id, technology)) = selected_technology_id(base).and_then(|id| {
        state
            .catalog
            .technologies
            .get(id)
            .map(|technology| (id, technology))
    }) {
        let progress = base
            .get("research")
            .and_then(Value::as_object)
            .and_then(|research| research.get("progressByTech"))
            .and_then(Value::as_object)
            .and_then(|progress| progress.get(technology_id))
            .and_then(Value::as_object);
        return technology
            .costs
            .iter()
            .filter_map(|cost| {
                let completed = progress
                    .and_then(|values| values.get(&cost.item_id))
                    .map(|value| finite_number(Some(value)))
                    .unwrap_or(0.0);
                let remaining = (cost.amount - completed).max(0.0);
                (remaining > 0.0).then(|| (cost.item_id.clone(), remaining))
            })
            .collect();
    }
    let Some(infinite_id) = active_infinite_research_id(base).filter(|_| endgame_unlocked(base))
    else {
        return Vec::new();
    };
    let progress = base
        .get("endgame")
        .and_then(Value::as_object)
        .and_then(|endgame| endgame.get("infiniteResearch"))
        .and_then(Value::as_object)
        .and_then(|research| research.get(infinite_id))
        .and_then(Value::as_object);
    let level = progress
        .and_then(|progress| progress.get("level"))
        .map(|value| {
            finite_number(Some(value))
                .floor()
                .clamp(0.0, u32::MAX as f64) as u32
        })
        .unwrap_or(0);
    if crate::infinite_research::maximum_level(infinite_id).is_none_or(|maximum| level >= maximum) {
        return Vec::new();
    }
    let completed = progress
        .and_then(|progress| progress.get("progress"))
        .and_then(Value::as_str)
        .and_then(|value| value.parse::<u128>().ok())
        .unwrap_or(0);
    let remaining = crate::infinite_research::cost(infinite_id, level)
        .unwrap_or(0)
        .saturating_sub(completed)
        .min(MAX_BUILDING_BUFFER_LIMIT as u128);
    if remaining > 0 {
        vec![("universe_matrix".to_owned(), remaining as f64)]
    } else {
        Vec::new()
    }
}

/// Disposable, current-step proof for the global research barrier. It never
/// enters GameState, a prepared runtime, a checkpoint or a canonical hash.
/// The sparse ordinary-production selector may be used only when the current
/// research target is inactive, at least one required matrix cannot possibly
/// be supplied by every research lab combined during this step, or a strict
/// cycle ceiling remains below the amount needed to cross the boundary.
///
/// Belt input movement has already completed before this proof is captured;
/// no later phase can add to a matrix-lab input before research settlement.
/// Therefore current lab inventory is a strict material upper bound. We do
/// not try to infer row ordering: if the material bound cannot exclude a
/// boundary, the exact legacy full scan remains the oracle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ResearchCompletionBoundaryProof {
    Inactive,
    CannotCompleteThisStep,
    RequiresFullScan(&'static str),
}

impl ResearchCompletionBoundaryProof {
    fn requires_full_scan(self) -> bool {
        matches!(self, Self::RequiresFullScan(_))
    }

    fn profile_label(self) -> &'static str {
        match self {
            Self::Inactive => "inactive",
            Self::CannotCompleteThisStep => "strict-upper-bound",
            Self::RequiresFullScan(reason) => reason,
        }
    }
}

fn catalog_integer(value: f64) -> Option<u128> {
    const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
    (value.is_finite() && (0.0..=MAX_SAFE_INTEGER).contains(&value) && value.fract() == 0.0)
        .then_some(value as u128)
}

fn legacy_available_integer(value: Option<&Value>) -> Option<u128> {
    const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
    let value = value.and_then(Value::as_f64).unwrap_or(0.0);
    if !value.is_finite() || value > MAX_SAFE_INTEGER {
        return None;
    }
    Some((value.max(0.0) + EPSILON).floor() as u128)
}

fn summed_research_lab_inventory(
    state: &CoreState,
    entities: &[Value],
    item_id: &str,
) -> Option<u128> {
    let mut available = 0_u128;
    for &entity_index in &state.factory_topology.research_entity_indices {
        if entity_index >= state.entities.ids.len() {
            return None;
        }
        let entity = entities.get(entity_index)?.as_object()?;
        if entity.get("id").and_then(Value::as_str) != Some(&state.entities.ids[entity_index])
            || entity.get("kind").and_then(Value::as_str) != Some("machine")
            || entity.get("recipeId").and_then(Value::as_str) != Some("matrix_research")
            || state
                .symbols
                .resolve(*state.entities.recipes.get(entity_index)?)
                != Some("matrix_research")
            || entity.keys().any(|key| key.starts_with("mod:"))
        {
            return None;
        }
        let amount = legacy_available_integer(
            entity
                .get("inputs")
                .and_then(Value::as_object)
                .and_then(|inputs| inputs.get(item_id)),
        )?;
        available = available.checked_add(amount)?;
    }
    Some(available)
}

/// Conservative integer-cycle ceiling for every research row combined. The
/// actual settlement multiplies by a power factor in [0, 1], may run at base
/// speed after spray is exhausted, and is further capped by material. This
/// proof deliberately assumes full power, the speed-spray multiplier for the
/// entire step, and no input/output cap. A relative and absolute floating
/// margin is added before ceil so conversion can only overestimate.
fn maximum_research_cycles_this_step(
    state: &CoreState,
    base: &Map<String, Value>,
    entities: &[Value],
    seconds: f64,
) -> Option<u128> {
    const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
    if !seconds.is_finite() || seconds < 0.0 {
        return None;
    }
    let research_speed = research_speed_multiplier(base);
    if !research_speed.is_finite() || research_speed < 0.0 {
        return None;
    }
    let mut total = 0_u128;
    for &entity_index in &state.factory_topology.research_entity_indices {
        let entity = entities.get(entity_index)?.as_object()?;
        let building_id = entity.get("buildingId").and_then(Value::as_str)?;
        let recipe_id = entity.get("recipeId").and_then(Value::as_str)?;
        if recipe_id != "matrix_research"
            || entity.keys().any(|key| key.starts_with("mod:"))
            || state
                .symbols
                .resolve(*state.entities.recipes.get(entity_index)?)
                != Some("matrix_research")
            || state
                .symbols
                .resolve(*state.entities.buildings.get(entity_index)?)
                != Some(building_id)
        {
            return None;
        }
        let building = state.catalog.buildings.get(building_id)?;
        let recipe = state.catalog.recipes.get(recipe_id)?;
        let machine_count = entity.get("machineCount")?.as_f64()?;
        let progress = entity
            .get("progress")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        if !machine_count.is_finite()
            || !(0.0..=MAX_SAFE_INTEGER).contains(&machine_count)
            || !progress.is_finite()
            || progress > MAX_SAFE_INTEGER
            || !building.speed.is_finite()
            || building.speed < 0.0
            || !recipe.duration.is_finite()
            || recipe.duration <= 0.0
        {
            return None;
        }
        let planet_index = *state
            .factory_topology
            .entity_planet_indices
            .get(entity_index)?;
        let planet = state.catalog.planets.get(planet_index)?;
        let profile = profile_for(base, &planet.id, &planet.system_id).ok()?;
        let planet_speed = if specialization_applies(profile, building) {
            profile.production_speed_multiplier
        } else {
            1.0
        };
        let speed_spray = proliferator_speed_multiplier(state, entity, recipe).max(1.0);
        if !planet_speed.is_finite()
            || planet_speed < 0.0
            || !speed_spray.is_finite()
            || speed_spray < 1.0
        {
            return None;
        }
        let per_second = building.speed * machine_count * research_speed * planet_speed
            / recipe.duration
            * speed_spray;
        let raw_upper = progress.max(0.0) + per_second * seconds;
        let biased_upper = raw_upper * (1.0 + 16.0 * f64::EPSILON) + 4.0;
        if !biased_upper.is_finite() || biased_upper > MAX_SAFE_INTEGER {
            return None;
        }
        total = total.checked_add(biased_upper.ceil() as u128)?;
    }
    Some(total)
}

fn finite_research_boundary_proof(
    state: &CoreState,
    base: &Map<String, Value>,
    entities: &[Value],
    technology_id: &str,
    seconds: f64,
) -> ResearchCompletionBoundaryProof {
    let Some(technology) = state.catalog.technologies.get(technology_id) else {
        return ResearchCompletionBoundaryProof::RequiresFullScan("finite-catalog-unproved");
    };
    if technology.costs.is_empty() || completed_tech(base, technology_id) {
        return ResearchCompletionBoundaryProof::RequiresFullScan("finite-state-boundary");
    }
    let progress = base
        .get("research")
        .and_then(Value::as_object)
        .and_then(|research| research.get("progressByTech"))
        .and_then(Value::as_object)
        .and_then(|progress| progress.get(technology_id))
        .and_then(Value::as_object);
    let mut total_remaining = 0_u128;
    let mut cost_item_ids = HashSet::with_capacity(technology.costs.len());
    for cost in &technology.costs {
        if !cost_item_ids.insert(cost.item_id.as_str()) {
            return ResearchCompletionBoundaryProof::RequiresFullScan("finite-duplicate-cost-item");
        }
        let Some(required) = catalog_integer(cost.amount) else {
            return ResearchCompletionBoundaryProof::RequiresFullScan("finite-cost-unproved");
        };
        if required == 0 {
            return ResearchCompletionBoundaryProof::RequiresFullScan("finite-zero-cost");
        }
        let completed = progress
            .and_then(|progress| progress.get(&cost.item_id))
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        if !completed.is_finite() || completed > 9_007_199_254_740_991.0 {
            return ResearchCompletionBoundaryProof::RequiresFullScan("finite-progress-unproved");
        }
        // Research invests whole items but legacy progress may contain a
        // fractional import. Ceil is the exact number of additional integer
        // items required to make floor(progress) reach the integer cost.
        let remaining = ((required as f64 - completed.max(0.0)).max(0.0)).ceil() as u128;
        total_remaining = match total_remaining.checked_add(remaining) {
            Some(total) => total,
            None => {
                return ResearchCompletionBoundaryProof::RequiresFullScan(
                    "finite-remaining-overflow",
                );
            }
        };
        if remaining == 0 {
            continue;
        }
        let Some(available) = summed_research_lab_inventory(state, entities, &cost.item_id) else {
            return ResearchCompletionBoundaryProof::RequiresFullScan("finite-inventory-unproved");
        };
        if available < remaining {
            return ResearchCompletionBoundaryProof::CannotCompleteThisStep;
        }
    }
    if total_remaining == 0 {
        return ResearchCompletionBoundaryProof::RequiresFullScan("finite-state-boundary");
    }
    match maximum_research_cycles_this_step(state, base, entities, seconds) {
        Some(maximum_cycles) if maximum_cycles < total_remaining => {
            return ResearchCompletionBoundaryProof::CannotCompleteThisStep;
        }
        Some(_) => {}
        None => {
            return ResearchCompletionBoundaryProof::RequiresFullScan("finite-cycle-unproved");
        }
    }
    ResearchCompletionBoundaryProof::RequiresFullScan("finite-boundary-possible")
}

fn infinite_research_boundary_proof(
    state: &CoreState,
    base: &Map<String, Value>,
    entities: &[Value],
    research_id: &str,
    seconds: f64,
) -> ResearchCompletionBoundaryProof {
    if !crate::infinite_research::valid_id(research_id) {
        return ResearchCompletionBoundaryProof::RequiresFullScan("infinite-catalog-unproved");
    }
    let Some(progress) = base
        .get("endgame")
        .and_then(Value::as_object)
        .and_then(|endgame| endgame.get("infiniteResearch"))
        .and_then(Value::as_object)
        .and_then(|research| research.get(research_id))
        .and_then(Value::as_object)
    else {
        return ResearchCompletionBoundaryProof::RequiresFullScan("infinite-state-unproved");
    };
    let Some(level) = progress
        .get("level")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value >= 0.0 && value.fract() == 0.0)
        .filter(|value| *value <= u32::MAX as f64)
        .map(|value| value as u32)
    else {
        return ResearchCompletionBoundaryProof::RequiresFullScan("infinite-level-unproved");
    };
    if crate::infinite_research::maximum_level(research_id).is_none_or(|maximum| level >= maximum) {
        return ResearchCompletionBoundaryProof::RequiresFullScan("infinite-maximum-boundary");
    }
    let Some(completed) = progress
        .get("progress")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()))
        .and_then(|value| value.parse::<u128>().ok())
    else {
        return ResearchCompletionBoundaryProof::RequiresFullScan("infinite-progress-unproved");
    };
    let Ok(required) = crate::infinite_research::cost(research_id, level) else {
        return ResearchCompletionBoundaryProof::RequiresFullScan("infinite-cost-unproved");
    };
    let remaining = required.saturating_sub(completed.min(required));
    let Some(available) = summed_research_lab_inventory(state, entities, "universe_matrix") else {
        return ResearchCompletionBoundaryProof::RequiresFullScan("infinite-inventory-unproved");
    };
    let cycle_ceiling_excludes_completion = remaining > 0
        && maximum_research_cycles_this_step(state, base, entities, seconds)
            .is_some_and(|maximum_cycles| maximum_cycles < remaining);
    if remaining > available || cycle_ceiling_excludes_completion {
        ResearchCompletionBoundaryProof::CannotCompleteThisStep
    } else {
        ResearchCompletionBoundaryProof::RequiresFullScan("infinite-boundary-possible")
    }
}

fn research_completion_boundary_proof(
    state: &CoreState,
    base: &Map<String, Value>,
    entities: &[Value],
    seconds: f64,
) -> ResearchCompletionBoundaryProof {
    let Some(research) = base.get("research").and_then(Value::as_object) else {
        return ResearchCompletionBoundaryProof::RequiresFullScan("research-state-unproved");
    };
    let selected = match research.get("selectedTechId") {
        Some(Value::String(id)) if !id.is_empty() => Some(id.as_str()),
        Some(Value::Null) | None => None,
        _ => {
            return ResearchCompletionBoundaryProof::RequiresFullScan("finite-selection-unproved");
        }
    };
    if let Some(technology_id) = selected {
        return finite_research_boundary_proof(state, base, entities, technology_id, seconds);
    }
    let active_infinite = base
        .get("endgame")
        .and_then(Value::as_object)
        .and_then(|endgame| endgame.get("activeInfiniteResearchId"));
    match active_infinite {
        Some(Value::String(id)) if !id.is_empty() && endgame_unlocked(base) => {
            infinite_research_boundary_proof(state, base, entities, id, seconds)
        }
        Some(Value::String(_)) | Some(Value::Null) | None => {
            ResearchCompletionBoundaryProof::Inactive
        }
        _ => ResearchCompletionBoundaryProof::RequiresFullScan("infinite-selection-unproved"),
    }
}

fn reset_research_machine_progress(entities: &mut [Value]) -> anyhow::Result<()> {
    for entity in entities.iter_mut().filter_map(Value::as_object_mut) {
        if string_at(entity, "recipeId") == Some("matrix_research") {
            set_number(entity, "progress", 0.0)?;
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub(crate) enum PlayerResearchTransition {
    SelectFinite(String),
    PauseCurrent,
    CancelCurrent,
    SelectInfinite(Option<String>),
}

/// Applies the exact player-facing research lifecycle rules to a disposable
/// command candidate. The command layer deliberately calls this shared helper
/// instead of reimplementing completion rewards or matrix-lab resets.
pub(crate) fn apply_player_research_transition(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entities: &mut [Value],
    transition: &PlayerResearchTransition,
) -> anyhow::Result<()> {
    match transition {
        PlayerResearchTransition::SelectFinite(technology_id) => {
            let research = base
                .get_mut("research")
                .and_then(Value::as_object_mut)
                .ok_or_else(|| anyhow!("native research state is missing"))?;
            research.insert(
                "selectedTechId".to_owned(),
                Value::from(technology_id.as_str()),
            );
            if research.get("pausedTechId").and_then(Value::as_str) == Some(technology_id.as_str())
            {
                research.insert("pausedTechId".to_owned(), Value::Null);
            }
            reset_research_machine_progress(entities)?;
            settle_completed_research_boundaries(state, base, entities)?;
        }
        PlayerResearchTransition::PauseCurrent => {
            let selected = selected_technology_id(base).map(str::to_owned);
            let research = base
                .get_mut("research")
                .and_then(Value::as_object_mut)
                .ok_or_else(|| anyhow!("native research state is missing"))?;
            if let Some(technology_id) = selected {
                research.insert("pausedTechId".to_owned(), Value::from(technology_id));
                research.insert("selectedTechId".to_owned(), Value::Null);
            }
            base.get_mut("endgame")
                .and_then(Value::as_object_mut)
                .ok_or_else(|| anyhow!("native endgame state is missing"))?
                .insert("activeInfiniteResearchId".to_owned(), Value::Null);
            reset_research_machine_progress(entities)?;
        }
        PlayerResearchTransition::CancelCurrent => {
            let completed_before = base
                .get("research")
                .and_then(Value::as_object)
                .and_then(|research| research.get("completedTechIds"))
                .and_then(Value::as_array)
                .map(Vec::len)
                .ok_or_else(|| anyhow!("native completed technology list is missing"))?;
            settle_completed_research_boundaries(state, base, entities)?;
            let completed_after = base
                .get("research")
                .and_then(Value::as_object)
                .and_then(|research| research.get("completedTechIds"))
                .and_then(Value::as_array)
                .map(Vec::len)
                .ok_or_else(|| anyhow!("native completed technology list is missing"))?;
            if completed_after > completed_before {
                return Ok(());
            }
            base.get_mut("research")
                .and_then(Value::as_object_mut)
                .ok_or_else(|| anyhow!("native research state is missing"))?
                .insert("selectedTechId".to_owned(), Value::Null);
            base.get_mut("endgame")
                .and_then(Value::as_object_mut)
                .ok_or_else(|| anyhow!("native endgame state is missing"))?
                .insert("activeInfiniteResearchId".to_owned(), Value::Null);
            activate_next_queued_technology(state, base)?;
            reset_research_machine_progress(entities)?;
        }
        PlayerResearchTransition::SelectInfinite(target) => {
            base.get_mut("endgame")
                .and_then(Value::as_object_mut)
                .ok_or_else(|| anyhow!("native endgame state is missing"))?
                .insert(
                    "activeInfiniteResearchId".to_owned(),
                    target.as_deref().map(Value::from).unwrap_or(Value::Null),
                );
            reset_research_machine_progress(entities)?;
        }
    }
    Ok(())
}

fn reset_indexed_research_machine_progress(
    entities: &mut [Value],
    research_entity_indexes: &[usize],
) -> anyhow::Result<()> {
    for &entity_index in research_entity_indexes {
        let entity = entities
            .get_mut(entity_index)
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native indexed research entity is invalid"))?;
        set_number(entity, "progress", 0.0)?;
    }
    Ok(())
}

fn activate_next_queued_technology(
    state: &CoreState,
    base: &mut Map<String, Value>,
) -> anyhow::Result<()> {
    let completed = base
        .get("research")
        .and_then(Value::as_object)
        .and_then(|research| research.get("completedTechIds"))
        .and_then(Value::as_array)
        .map(|ids| ids.iter().filter_map(Value::as_str).collect::<HashSet<_>>())
        .unwrap_or_default();
    let queue = base
        .get("research")
        .and_then(Value::as_object)
        .and_then(|research| research.get("queuedTechIds"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let next_index = queue.iter().position(|id| {
        id.as_str()
            .and_then(|id| state.catalog.technologies.get(id))
            .is_some_and(|technology| {
                technology
                    .prerequisites
                    .iter()
                    .all(|id| completed.contains(id.as_str()))
            })
    });
    let research = base
        .get_mut("research")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native research state is missing"))?;
    let queued = research
        .get_mut("queuedTechIds")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| anyhow!("native research queue is missing"))?;
    if let Some(index) = next_index {
        let next = queued.remove(index);
        research.insert("selectedTechId".to_owned(), next);
    } else {
        research.insert("selectedTechId".to_owned(), Value::Null);
    }
    Ok(())
}

fn complete_technology(
    state: &CoreState,
    base: &mut Map<String, Value>,
    has_galactic_material_exporter: bool,
    technology_id: &str,
) -> anyhow::Result<()> {
    let technology = state
        .catalog
        .technologies
        .get(technology_id)
        .ok_or_else(|| anyhow!("native technology catalog entry is missing"))?;
    let already_completed = base
        .get("research")
        .and_then(Value::as_object)
        .and_then(|research| research.get("completedTechIds"))
        .and_then(Value::as_array)
        .is_some_and(|ids| ids.iter().any(|id| id.as_str() == Some(technology_id)));
    if already_completed {
        return Ok(());
    }
    base.get_mut("research")
        .and_then(Value::as_object_mut)
        .and_then(|research| research.get_mut("completedTechIds"))
        .and_then(Value::as_array_mut)
        .ok_or_else(|| anyhow!("native completed technology list is missing"))?
        .push(Value::from(technology_id));
    let construction = base
        .get_mut("construction")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native construction inventory is missing"))?;
    for reward in &technology.construction_rewards {
        let current = finite_number(construction.get(reward));
        construction.insert(
            reward.clone(),
            Number::from_f64((current + 2.0).floor())
                .map(Value::Number)
                .unwrap_or(Value::from(0)),
        );
    }
    if technology_id == "universe_matrix"
        && !has_galactic_material_exporter
        && finite_number(construction.get("galactic_material_exporter")).floor() < 1.0
    {
        construction.insert("galactic_material_exporter".to_owned(), Value::from(1));
    }
    if technology_id == "interstellar_logistics" {
        let colonized = base
            .get_mut("exploration")
            .and_then(Value::as_object_mut)
            .and_then(|exploration| exploration.get_mut("colonizedPlanetIds"))
            .and_then(Value::as_array_mut)
            .ok_or_else(|| anyhow!("native colonized planet list is missing"))?;
        for planet in ["ashen", "giant"] {
            if !colonized.iter().any(|value| value.as_str() == Some(planet)) {
                colonized.push(Value::from(planet));
            }
        }
    }
    Ok(())
}

fn settle_completed_research_boundaries(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entities: &mut [Value],
) -> anyhow::Result<()> {
    let queue_len = base
        .get("research")
        .and_then(Value::as_object)
        .and_then(|research| research.get("queuedTechIds"))
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);
    let limit = state.catalog.recipes.len() + queue_len + 8;
    for _ in 0..limit {
        let Some(technology_id) = selected_technology_id(base).map(str::to_owned) else {
            break;
        };
        let Some(technology) = state.catalog.technologies.get(&technology_id).cloned() else {
            activate_next_queued_technology(state, base)?;
            continue;
        };
        if completed_tech(base, &technology_id) {
            activate_next_queued_technology(state, base)?;
            continue;
        }
        let complete = technology.costs.iter().all(|cost| {
            base.get("research")
                .and_then(Value::as_object)
                .and_then(|research| research.get("progressByTech"))
                .and_then(Value::as_object)
                .and_then(|progress| progress.get(&technology_id))
                .and_then(Value::as_object)
                .and_then(|progress| progress.get(&cost.item_id))
                .map(|value| finite_number(Some(value)).floor() >= cost.amount)
                .unwrap_or(false)
        });
        if !complete {
            break;
        }
        let progress = base
            .get_mut("research")
            .and_then(Value::as_object_mut)
            .and_then(|research| research.get_mut("progressByTech"))
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native research progress directory is missing"))?
            .entry(technology_id.clone())
            .or_insert_with(|| Value::Object(Map::new()))
            .as_object_mut()
            .ok_or_else(|| anyhow!("native research progress entry is invalid"))?;
        for cost in &technology.costs {
            progress.insert(
                cost.item_id.clone(),
                Number::from_f64(cost.amount)
                    .map(Value::Number)
                    .unwrap_or(Value::from(0)),
            );
        }
        let has_exporter = entities
            .iter()
            .filter_map(Value::as_object)
            .any(|entity| string_at(entity, "buildingId") == Some("galactic_material_exporter"));
        complete_technology(state, base, has_exporter, &technology_id)?;
        activate_next_queued_technology(state, base)?;
        reset_research_machine_progress(entities)?;
    }
    Ok(())
}

fn invest_finite_research(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entity: &mut Map<String, Value>,
    requested_cycles: f64,
    has_galactic_material_exporter: bool,
) -> anyhow::Result<(f64, bool)> {
    if requested_cycles < 1.0 {
        return Ok((0.0, false));
    }
    let Some(technology_id) = selected_technology_id(base).map(str::to_owned) else {
        return Ok((0.0, false));
    };
    let Some(technology) = state.catalog.technologies.get(&technology_id).cloned() else {
        return Ok((0.0, false));
    };
    let current_progress = base
        .get("research")
        .and_then(Value::as_object)
        .and_then(|research| research.get("progressByTech"))
        .and_then(Value::as_object)
        .and_then(|progress| progress.get(&technology_id))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut progress = current_progress;
    let mut remaining_cycles = requested_cycles.floor().max(0.0);
    let mut consumed = 0.0;
    for cost in &technology.costs {
        if remaining_cycles < 1.0 {
            break;
        }
        let completed = finite_number(progress.get(&cost.item_id));
        let remaining_cost = (cost.amount - completed).max(0.0);
        let available = entity
            .get("inputs")
            .and_then(Value::as_object)
            .and_then(|inputs| inputs.get(&cost.item_id))
            .map(|value| (finite_number(Some(value)) + EPSILON).floor())
            .unwrap_or(0.0);
        let amount = remaining_cycles.min(remaining_cost).min(available).floor();
        if amount < 1.0 {
            continue;
        }
        entity
            .get_mut("inputs")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native research machine inputs are missing"))?
            .insert(
                cost.item_id.clone(),
                Number::from_f64(available - amount)
                    .map(Value::Number)
                    .unwrap_or(Value::from(0)),
            );
        progress.insert(
            cost.item_id.clone(),
            Number::from_f64((completed + amount).floor())
                .map(Value::Number)
                .unwrap_or(Value::from(0)),
        );
        remaining_cycles -= amount;
        consumed += amount;
    }
    base.get_mut("research")
        .and_then(Value::as_object_mut)
        .and_then(|research| research.get_mut("progressByTech"))
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native research progress directory is missing"))?
        .insert(technology_id.clone(), Value::Object(progress.clone()));
    let completed = technology
        .costs
        .iter()
        .all(|cost| finite_number(progress.get(&cost.item_id)).floor() >= cost.amount);
    if completed {
        complete_technology(state, base, has_galactic_material_exporter, &technology_id)?;
        activate_next_queued_technology(state, base)?;
    }
    Ok((consumed, completed))
}

fn parse_decimal_u128(value: Option<&str>) -> anyhow::Result<u128> {
    let value = value.unwrap_or("0");
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Ok(0);
    }
    value
        .parse::<u128>()
        .map_err(|_| anyhow!("native infinite research integer exceeds u128"))
}

fn invest_infinite_research(
    base: &mut Map<String, Value>,
    entity: &mut Map<String, Value>,
    requested_cycles: f64,
) -> anyhow::Result<(f64, bool)> {
    if requested_cycles < 1.0 || !endgame_unlocked(base) {
        return Ok((0.0, false));
    }
    let Some(research_id) = active_infinite_research_id(base).map(str::to_owned) else {
        return Ok((0.0, false));
    };
    let available = (item_amount(entity, "inputs", "universe_matrix") + EPSILON).floor();
    let requested = requested_cycles.floor().min(available).max(0.0) as u128;
    if requested == 0 {
        return Ok((0.0, false));
    }
    let (level, progress, auto_research) = {
        let endgame = base
            .get("endgame")
            .and_then(Value::as_object)
            .ok_or_else(|| anyhow!("native endgame state is missing"))?;
        let progress = endgame
            .get("infiniteResearch")
            .and_then(Value::as_object)
            .and_then(|values| values.get(&research_id))
            .and_then(Value::as_object)
            .ok_or_else(|| anyhow!("native infinite research progress is missing"))?;
        (
            finite_number(progress.get("level")).floor().max(0.0) as u32,
            parse_decimal_u128(progress.get("progress").and_then(Value::as_str))?,
            endgame
                .get("autoResearch")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        )
    };
    let settlement =
        crate::infinite_research::settle(&research_id, level, progress, requested, auto_research)?;
    let consumed = settlement.consumed as f64;
    if settlement.consumed > 0 {
        set_item_amount(entity, "inputs", "universe_matrix", available - consumed)?;
    }
    let endgame = base
        .get_mut("endgame")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native endgame state is missing"))?;
    let progress = endgame
        .get_mut("infiniteResearch")
        .and_then(Value::as_object_mut)
        .and_then(|values| values.get_mut(&research_id))
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native infinite research progress is missing"))?;
    progress.insert("level".to_owned(), Value::from(settlement.level));
    progress.insert(
        "progress".to_owned(),
        Value::from(settlement.progress.to_string()),
    );
    let score_gain = settlement
        .completed_levels
        .iter()
        .map(|level| 1_000.0 + f64::from(*level) * 250.0)
        .sum::<f64>();
    if score_gain > 0.0 {
        let score = finite_number(endgame.get("galacticScore"));
        set_number(endgame, "galacticScore", (score + score_gain).floor())?;
    }
    if settlement.reached_maximum || !auto_research && !settlement.completed_levels.is_empty() {
        endgame.insert("activeInfiniteResearchId".to_owned(), Value::Null);
    }
    Ok((consumed, settlement.consumed > 0))
}

fn ordinary_machine_input_cycles(entity: &Map<String, Value>, recipe: &RecipeDefinition) -> f64 {
    let inputs = entity.get("inputs").and_then(Value::as_object);
    recipe
        .inputs
        .iter()
        .fold(f64::INFINITY, |available, input| {
            available.min(
                inputs
                    .and_then(|values| values.get(&input.item_id))
                    .map(|value| finite_number(Some(value)))
                    .unwrap_or(0.0)
                    / input.amount,
            )
        })
}

fn machine_input_cycles(
    state: &CoreState,
    base: &Map<String, Value>,
    entity: &Map<String, Value>,
    recipe: &RecipeDefinition,
) -> f64 {
    let inputs = entity.get("inputs").and_then(Value::as_object);
    if recipe.id == "matrix_research" {
        if selected_technology_id(base).is_none()
            && active_infinite_research_id(base).is_some()
            && endgame_unlocked(base)
        {
            return inputs
                .and_then(|values| values.get("universe_matrix"))
                .map(|value| (finite_number(Some(value)) + EPSILON).floor())
                .unwrap_or(0.0);
        }
        return remaining_research_costs(state, base)
            .iter()
            .map(|(item_id, remaining)| {
                remaining.min(
                    inputs
                        .and_then(|values| values.get(item_id))
                        .map(|value| (finite_number(Some(value)) + EPSILON).floor())
                        .unwrap_or(0.0),
                )
            })
            .sum();
    }
    ordinary_machine_input_cycles(entity, recipe)
}

fn machine_output_cycles(
    state: &CoreState,
    entity: &Map<String, Value>,
    recipe: &RecipeDefinition,
    capacity: f64,
    maximum: f64,
    credits: Option<&crate::belts::OutputCredits>,
) -> f64 {
    let extra_bonus = proliferator_extra_bonus(state, entity, recipe);
    let sprayed_cycle_limit = available_full_proliferator_cycles(state, entity, recipe);
    machine_output_cycles_with_proliferator(
        state,
        entity,
        recipe,
        capacity,
        maximum,
        credits,
        extra_bonus,
        sprayed_cycle_limit,
    )
}

#[allow(clippy::too_many_arguments)]
fn machine_output_cycles_with_proliferator(
    state: &CoreState,
    entity: &Map<String, Value>,
    recipe: &RecipeDefinition,
    capacity: f64,
    maximum: f64,
    credits: Option<&crate::belts::OutputCredits>,
    extra_bonus: f64,
    sprayed_cycle_limit: f64,
) -> f64 {
    let entity_id = string_at(entity, "id").unwrap_or_default();
    let outputs = entity.get("outputs").and_then(Value::as_object);
    recipe
        .outputs
        .iter()
        .fold(f64::INFINITY, |available, output| {
            let current = outputs
                .and_then(|values| values.get(&output.item_id))
                .map(|value| finite_number(Some(value)))
                .unwrap_or(0.0);
            let free = ((capacity - current).max(0.0)
                + credits
                    .map(|credits| {
                        crate::belts::output_credit(state, credits, entity_id, &output.item_id)
                    })
                    .unwrap_or(0.0)
                + EPSILON)
                .floor();
            let mut low = 0.0;
            let mut high = (free / output.amount).floor().min(maximum.floor().max(0.0));
            let bonus_progress = entity
                .get("proliferatorBonusProgress")
                .and_then(Value::as_object)
                .and_then(|values| values.get(&output.item_id))
                .map(|value| finite_number(Some(value)))
                .unwrap_or(0.0);
            if extra_bonus <= EPSILON || sprayed_cycle_limit < 1.0 {
                let static_bonus = (bonus_progress + EPSILON).floor();
                return available.min(
                    high.min(((free - static_bonus) / output.amount).floor())
                        .max(0.0),
                );
            }
            if high > sprayed_cycle_limit {
                let bonus_at_limit =
                    (bonus_progress + output.amount * sprayed_cycle_limit * extra_bonus + EPSILON)
                        .floor();
                let beyond_spray = high
                    .min(((free - bonus_at_limit) / output.amount).floor())
                    .max(0.0);
                if beyond_spray >= sprayed_cycle_limit {
                    return available.min(beyond_spray);
                }
                high = high.min(sprayed_cycle_limit);
            }
            while low < high {
                let candidate = ((low + high) / 2.0).ceil();
                let sprayed = candidate.min(sprayed_cycle_limit);
                let bonus =
                    (bonus_progress + output.amount * sprayed * extra_bonus + EPSILON).floor();
                if output.amount * candidate + bonus <= free {
                    low = candidate;
                } else {
                    high = candidate - 1.0;
                }
            }
            available.min(low)
        })
}

fn is_local_machine_settlement_recipe(recipe_id: &str) -> bool {
    !matches!(
        recipe_id,
        "matrix_research" | "solar_sail_launch" | "carrier_rocket_launch"
    )
}

fn plan_local_machine_settlement(
    state: &CoreState,
    runtime: &DeterministicRuntime,
    machine_indices: &[usize],
) -> MachineLocalSettlementPlan {
    plan_local_machine_settlement_with_threshold(
        state,
        runtime,
        machine_indices,
        PARALLEL_MIN_ITEMS,
    )
}

fn plan_local_machine_settlement_with_threshold(
    state: &CoreState,
    runtime: &DeterministicRuntime,
    machine_indices: &[usize],
    parallel_min_items: usize,
) -> MachineLocalSettlementPlan {
    debug_assert!(parallel_min_items > 0);
    let mut plan = MachineLocalSettlementPlan::default();
    let parallel_allowed =
        runtime.worker_limit() > 1 && machine_indices.len() >= parallel_min_items;
    let mut candidate_indices = Vec::new();

    for &entity_index in machine_indices {
        let recipe_id = state
            .symbols
            .resolve(state.entities.recipes[entity_index])
            .unwrap_or_default();
        if !is_local_machine_settlement_recipe(recipe_id) {
            plan.global_barrier_count += 1;
            continue;
        }
        if !parallel_allowed {
            plan.serial_fallback_count += 1;
            continue;
        }
        // Missing catalog entries stay in the ordered candidate list so
        // context capture reports the same error at the original entity
        // position. Only a known, unusually wide MOD recipe falls back to the
        // legacy serial path because its result cannot fit the inline slot.
        if state
            .catalog
            .recipes
            .get(recipe_id)
            .is_some_and(|recipe| recipe.outputs.len() > MAX_PARALLEL_LOCAL_MACHINE_OUTPUTS)
        {
            plan.serial_fallback_count += 1;
        } else {
            candidate_indices.push(entity_index);
        }
    }
    if candidate_indices.len() >= parallel_min_items {
        plan.parallel_entity_count = candidate_indices.len();
        plan.batches.push(MachineLocalSettlementBatch {
            entity_indices: candidate_indices,
        });
    } else {
        plan.serial_fallback_count += candidate_indices.len();
    }
    plan
}

fn local_machine_settlement_context(
    state: &CoreState,
    base: &Map<String, Value>,
    entity_index: usize,
) -> anyhow::Result<MachineLocalSettlementContext> {
    let recipe_id = state
        .symbols
        .resolve(state.entities.recipes[entity_index])
        .unwrap_or_default();
    let recipe = state
        .catalog
        .recipes
        .get(recipe_id)
        .ok_or_else(|| anyhow!("native simple factory machine recipe is missing"))?;
    Ok(MachineLocalSettlementContext {
        technology_available: recipe_technology_available(base, recipe),
        industrial_speed: industrial_speed_multiplier(base),
        launch_factor: crate::dyson::launch_factor(base, &recipe.id),
    })
}

#[allow(clippy::too_many_arguments)]
fn settle_parallel_local_machine(
    state: &CoreState,
    context: MachineLocalSettlementContext,
    entity_index: usize,
    entity: &mut Value,
    profiles: &[PlanetProfile],
    power_factors: &HashMap<usize, f64>,
    output_credits: &crate::belts::OutputCredits,
    production_buffer_limit: f64,
    seconds: f64,
) -> anyhow::Result<MachineLocalSettlementDelta> {
    let object = entity_object(entity)?;
    let planet = state.factory_topology.entity_planet_indices[entity_index];
    let grid = state.factory_topology.entity_grid_indices[entity_index];
    if planet == usize::MAX || grid == usize::MAX {
        bail!("native simple factory entity topology is unknown");
    }
    let building_id = state
        .symbols
        .resolve(state.entities.buildings[entity_index])
        .unwrap_or_default();
    let recipe_id = state
        .symbols
        .resolve(state.entities.recipes[entity_index])
        .unwrap_or_default();
    if !is_local_machine_settlement_recipe(recipe_id) {
        bail!("native local machine settlement crossed a global recipe barrier");
    }
    let building = state
        .catalog
        .buildings
        .get(building_id)
        .ok_or_else(|| anyhow!("native simple factory machine building is missing"))?;
    let recipe = state
        .catalog
        .recipes
        .get(recipe_id)
        .ok_or_else(|| anyhow!("native simple factory machine recipe is missing"))?;
    if recipe.outputs.len() > MAX_PARALLEL_LOCAL_MACHINE_OUTPUTS {
        bail!("native local machine output width exceeded the parallel result budget");
    }
    if let Some(factor) = power_factors.get(&entity_index).copied() {
        set_number(object, "powerFactor", rounded(factor, 4))?;
    } else {
        object.remove("powerFactor");
    }
    if !context.technology_available {
        set_number(object, "progress", 0.0)?;
        set_number(object, "utilization", 0.0)?;
        set_number(object, "productionRate", 0.0)?;
        return Ok(MachineLocalSettlementDelta::default());
    }

    let machine_count = finite_number(object.get("machineCount"));
    let capacity = stacked_capacity(
        building.output_capacity,
        machine_count,
        production_buffer_limit,
    );
    let sprayed_cycle_limit = available_full_proliferator_cycles(state, object, recipe);
    let extra_product_bonus = proliferator_extra_bonus(state, object, recipe);
    let progress_at_start = finite_number(object.get("progress"));
    let input_cycles = (ordinary_machine_input_cycles(object, recipe) + EPSILON).floor();
    let output_cycles = (machine_output_cycles_with_proliferator(
        state,
        object,
        recipe,
        capacity,
        input_cycles,
        Some(output_credits),
        extra_product_bonus,
        sprayed_cycle_limit,
    ) + EPSILON)
        .floor();
    let maximum_cycles = input_cycles.min(output_cycles);
    let power_factor = power_factors.get(&entity_index).copied().unwrap_or(1.0);
    let planet_speed = if specialization_applies(profiles[planet], building) {
        profiles[planet].production_speed_multiplier
    } else {
        1.0
    };
    let effective_cycles_per_second =
        building.speed * machine_count * context.industrial_speed * planet_speed / recipe.duration;
    let launch_factor = context.launch_factor;
    let base_rate = effective_cycles_per_second * power_factor * launch_factor;
    let mut potential_cycles = base_rate * seconds;
    let mut sprayed_work = 0.0;
    if string_at(object, "proliferatorMode") == Some("speed")
        && sprayed_cycle_limit > 0.0
        && base_rate > EPSILON
    {
        let accelerated_rate = base_rate * proliferator_speed_multiplier(state, object, recipe);
        let accelerated_capacity =
            (maximum_cycles.min(sprayed_cycle_limit) - progress_at_start).max(0.0);
        let accelerated_seconds = seconds.min(accelerated_capacity / accelerated_rate.max(EPSILON));
        sprayed_work = accelerated_capacity.min(accelerated_rate * accelerated_seconds);
        potential_cycles = sprayed_work + base_rate * (seconds - accelerated_seconds).max(0.0);
    }
    if maximum_cycles < 1.0 || potential_cycles <= EPSILON {
        set_number(object, "utilization", 0.0)?;
        set_number(object, "productionRate", 0.0)?;
        return Ok(MachineLocalSettlementDelta::default());
    }

    let work = potential_cycles.min((maximum_cycles - progress_at_start).max(0.0));
    if string_at(object, "proliferatorMode") != Some("speed") {
        sprayed_work = work.min((sprayed_cycle_limit - progress_at_start).max(0.0));
    }
    let progressed = rounded(progress_at_start + work, 6);
    let cycles = maximum_cycles.min((progressed + EPSILON).floor());
    let sprayed_cycles = cycles.min(sprayed_cycle_limit);
    let inputs = object
        .get_mut("inputs")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native simple factory machine inputs are missing"))?;
    for input in &recipe.inputs {
        let current = finite_number(inputs.get(&input.item_id));
        set_machine_item_number(
            inputs,
            &input.item_id,
            (current - input.amount * cycles).max(0.0).floor(),
        );
    }
    consume_proliferator_points(state, object, recipe, sprayed_cycles)?;

    let mut delta = MachineLocalSettlementDelta::default();
    for (output_index, output) in recipe.outputs.iter().enumerate() {
        let accumulated_bonus = object
            .get("proliferatorBonusProgress")
            .and_then(Value::as_object)
            .and_then(|values| values.get(&output.item_id))
            .map(|value| finite_number(Some(value)))
            .unwrap_or(0.0)
            + output.amount * sprayed_cycles * extra_product_bonus;
        let bonus_produced = (accumulated_bonus + EPSILON).floor();
        let produced = output.amount * cycles + bonus_produced;
        let current = object
            .get("outputs")
            .and_then(Value::as_object)
            .and_then(|outputs| outputs.get(&output.item_id))
            .map(|value| finite_number(Some(value)))
            .unwrap_or(0.0);
        let outputs = object
            .get_mut("outputs")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native simple factory machine outputs are missing"))?;
        set_machine_item_number(outputs, &output.item_id, (current + produced).floor());
        let bonus_progress = object
            .get_mut("proliferatorBonusProgress")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native simple factory bonus record is missing"))?;
        set_machine_item_number(
            bonus_progress,
            &output.item_id,
            (accumulated_bonus - bonus_produced).max(0.0),
        );
        delta.produced[output_index] = produced;
    }
    delta.produced_len = recipe.outputs.len();

    set_number(
        object,
        "progress",
        rounded((progressed - cycles).max(0.0), 6),
    )?;
    let activity_factor = if potential_cycles > EPSILON {
        (work / potential_cycles).min(1.0)
    } else {
        0.0
    };
    set_number(
        object,
        "utilization",
        rounded(power_factor * launch_factor * activity_factor, 4),
    )?;
    let base_units_per_cycle = recipe
        .outputs
        .iter()
        .map(|output| output.amount)
        .sum::<f64>();
    let bonus_units_per_cycle = if work > EPSILON {
        base_units_per_cycle * extra_product_bonus * sprayed_work / work
    } else {
        0.0
    };
    set_number(
        object,
        "productionRate",
        rounded(
            work / seconds * (base_units_per_cycle + bonus_units_per_cycle) * 60.0,
            2,
        ),
    )?;
    Ok(delta)
}

#[allow(clippy::too_many_arguments)]
#[cfg(test)]
fn execute_local_machine_settlement_batch_with_runtime(
    runtime: &DeterministicRuntime,
    state: &CoreState,
    base: &Map<String, Value>,
    entities: &mut [Value],
    batch: MachineLocalSettlementBatch,
    profiles: &[PlanetProfile],
    power_factors: &HashMap<usize, f64>,
    output_credits: &crate::belts::OutputCredits,
    production_buffer_limit: f64,
    seconds: f64,
) -> Vec<MachineLocalSettlementOutcome> {
    let mut tasks = batch
        .entity_indices
        .into_iter()
        .map(|entity_index| MachineLocalSettlementTask {
            entity_index,
            entity: std::mem::take(&mut entities[entity_index]),
            context: local_machine_settlement_context(state, base, entity_index)
                .expect("test batch local machine context should resolve"),
            result: None,
        })
        .collect::<Vec<_>>();
    execute_local_machine_settlement_tasks_with_runtime(
        runtime,
        state,
        entities,
        &mut tasks,
        profiles,
        power_factors,
        output_credits,
        production_buffer_limit,
        seconds,
    )
}

#[allow(clippy::too_many_arguments)]
fn execute_local_machine_settlement_tasks_with_runtime(
    runtime: &DeterministicRuntime,
    state: &CoreState,
    entities: &mut [Value],
    tasks: &mut [MachineLocalSettlementTask],
    profiles: &[PlanetProfile],
    power_factors: &HashMap<usize, f64>,
    output_credits: &crate::belts::OutputCredits,
    production_buffer_limit: f64,
    seconds: f64,
) -> Vec<MachineLocalSettlementOutcome> {
    update_indexed_factory_probes_with_runtime(runtime, tasks, |task| {
        #[cfg(test)]
        if task.entity_index.is_multiple_of(127) {
            std::thread::yield_now();
        }
        task.result = Some(settle_parallel_local_machine(
            state,
            task.context,
            task.entity_index,
            &mut task.entity,
            profiles,
            power_factors,
            output_credits,
            production_buffer_limit,
            seconds,
        ));
    });
    tasks
        .iter_mut()
        .map(|task| {
            entities[task.entity_index] = std::mem::take(&mut task.entity);
            MachineLocalSettlementOutcome {
                entity_index: task.entity_index,
                result: task
                    .result
                    .take()
                    .expect("native local machine worker left a task unfinished"),
            }
        })
        .collect()
}

fn merge_local_machine_production(
    state: &CoreState,
    outcome: MachineLocalSettlementOutcome,
    produced_by_item: &mut HashMap<String, f64>,
) -> anyhow::Result<()> {
    let delta = outcome.result?;
    if delta.produced_len == 0 {
        return Ok(());
    }
    let recipe_id = state
        .symbols
        .resolve(state.entities.recipes[outcome.entity_index])
        .unwrap_or_default();
    let recipe = state
        .catalog
        .recipes
        .get(recipe_id)
        .ok_or_else(|| anyhow!("native simple factory machine recipe is missing"))?;
    if delta.produced_len != recipe.outputs.len()
        || delta.produced_len > MAX_PARALLEL_LOCAL_MACHINE_OUTPUTS
    {
        bail!("native local machine production result width diverged");
    }
    // Preserve the legacy per-entity and per-output IEEE-754 addition order.
    // Workers never touch this aggregate map.
    for (output, produced) in recipe.outputs.iter().zip(delta.produced) {
        add_produced_item(produced_by_item, &output.item_id, produced);
    }
    Ok(())
}

fn add_produced_item(produced_by_item: &mut HashMap<String, f64>, item_id: &str, produced: f64) {
    if let Some(current) = produced_by_item.get_mut(item_id) {
        *current += produced;
    } else {
        produced_by_item.insert(item_id.to_owned(), produced);
    }
}

fn machine_can_run(
    state: &CoreState,
    base: &Map<String, Value>,
    entity: &Map<String, Value>,
    building: &BuildingDefinition,
    recipe: &RecipeDefinition,
    buffer_limit: f64,
) -> bool {
    if !recipe_technology_available(base, recipe) {
        return false;
    }
    if proliferator_applies(entity, recipe)
        && proliferator_tier(entity)
            .and_then(|tier| state.catalog.proliferators.get(&tier))
            .is_none_or(|definition| !completed_tech(base, &definition.required_tech_id))
    {
        return false;
    }
    let capacity = stacked_capacity(
        building.output_capacity,
        finite_number(entity.get("machineCount")),
        buffer_limit,
    );
    if recipe.id == "matrix_research" && !has_active_research(base) {
        return false;
    }
    if recipe.id == "solar_sail_launch" && !crate::dyson::valid_ejector_target(state, base, entity)
    {
        return false;
    }
    (machine_input_cycles(state, base, entity, recipe) + EPSILON).floor() >= 1.0
        && (machine_output_cycles(state, entity, recipe, capacity, 1.0, None) + EPSILON).floor()
            >= 1.0
}

fn metric_value(grid_id: Option<&str>, grid: &GridRuntime, total_items_per_minute: f64) -> Value {
    let fuel_reserve_seconds = if grid.rated_fuel_generator_kw > EPSILON {
        rounded(
            grid.fuel_electric_energy_mj * 1_000.0 / grid.rated_fuel_generator_kw,
            1,
        )
    } else {
        0.0
    };
    let mut metric = json!({
        "generationKw": rounded(grid.generation_kw, 2),
        "demandKw": rounded(grid.demand_kw, 2),
        "powerFactor": rounded(grid.factor, 4),
        "windGenerationKw": rounded(grid.wind_generation_kw, 2),
        "solarGenerationKw": rounded(grid.solar_generation_kw, 2),
        "geothermalGenerationKw": rounded(grid.geothermal_generation_kw, 2),
        "thermalGenerationKw": rounded(grid.thermal_generation_kw, 2),
        "fusionGenerationKw": rounded(grid.fusion_generation_kw, 2),
        "artificialStarGenerationKw": rounded(grid.artificial_star_generation_kw, 2),
        "rayGenerationKw": rounded(grid.ray_generation_kw, 2),
        "storageDischargeKw": rounded(grid.storage_discharge_kw, 2),
        "storageChargeKw": rounded(grid.storage_charge_kw, 2),
        "storedEnergyMj": rounded(grid.stored_energy_mj, 3),
        "storageCapacityMj": rounded(grid.storage_capacity_mj, 3),
        "fuelReserveSeconds": fuel_reserve_seconds,
        "totalItemsPerMinute": rounded(total_items_per_minute, 2),
    });
    if let Some(grid_id) = grid_id {
        let object = metric.as_object_mut().expect("metric object");
        object.insert("gridId".to_owned(), Value::from(grid_id));
        object.insert(
            "connectedEntities".to_owned(),
            Value::from(grid.connected_entities),
        );
        object.insert(
            "disconnectedEntities".to_owned(),
            Value::from(grid.disconnected_entities),
        );
        object.insert(
            "generatorCount".to_owned(),
            Number::from_f64(grid.generator_count)
                .map(Value::Number)
                .unwrap_or(Value::from(0)),
        );
        object.insert("coverageRadius".to_owned(), Value::from(0));
    }
    metric
}

fn entity_object(entity: &mut Value) -> anyhow::Result<&mut Map<String, Value>> {
    entity
        .as_object_mut()
        .ok_or_else(|| anyhow!("native simple factory entity is not an object"))
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
        .ok_or_else(|| anyhow!("native power inventory record is missing"))?
        .insert(
            item_id.to_owned(),
            Number::from_f64(amount)
                .map(Value::Number)
                .ok_or_else(|| anyhow!("native power inventory amount is non-finite"))?,
        );
    Ok(())
}

fn add_total_produced(
    base: &mut Map<String, Value>,
    item_id: &str,
    amount: f64,
) -> anyhow::Result<()> {
    if amount <= 0.0 {
        return Ok(());
    }
    let total = base
        .get_mut("totalProduced")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native power total production record is missing"))?;
    let current = total
        .get(item_id)
        .map(|value| finite_number(Some(value)))
        .unwrap_or(0.0);
    total.insert(
        item_id.to_owned(),
        Number::from_f64((current + amount).floor())
            .map(Value::Number)
            .ok_or_else(|| anyhow!("native power total production is non-finite"))?,
    );
    Ok(())
}

fn burn_fuel(
    state: &CoreState,
    entity: &mut Map<String, Value>,
    building: &BuildingDefinition,
    output_kw: f64,
    seconds: f64,
) -> anyhow::Result<()> {
    let Some(fuel_item_id) = string_at(entity, "fuelItemId").map(str::to_owned) else {
        return Ok(());
    };
    if output_kw <= EPSILON {
        return Ok(());
    }
    let energy_per_item = state
        .catalog
        .items
        .get(&fuel_item_id)
        .map(|item| item.fuel_energy_mj)
        .unwrap_or(0.0);
    let required_heat_mj = (output_kw * seconds / (1_000.0 * building.fuel_efficiency)).max(0.0);
    let initial_heat_mj = finite_number(entity.get("fuelRemainingMj")).max(0.0);
    let queued_fuel = (item_amount(entity, "inputs", &fuel_item_id) + EPSILON).floor();
    if energy_per_item <= EPSILON {
        set_number(
            entity,
            "fuelRemainingMj",
            rounded(
                (initial_heat_mj - required_heat_mj.min(initial_heat_mj)).max(0.0),
                6,
            ),
        )?;
        return Ok(());
    }
    let heat_needed_after_current = (required_heat_mj - initial_heat_mj).max(0.0);
    let requested_items = if heat_needed_after_current > EPSILON {
        ((heat_needed_after_current - EPSILON).max(0.0) / energy_per_item).ceil()
    } else {
        0.0
    };
    let loaded = queued_fuel.min(requested_items);
    let available_heat_mj = initial_heat_mj + loaded * energy_per_item;
    let burned_heat_mj = required_heat_mj.min(available_heat_mj);
    if loaded > 0.0 {
        set_item_amount(entity, "inputs", &fuel_item_id, queued_fuel - loaded)?;
    }
    set_number(
        entity,
        "fuelRemainingMj",
        rounded((available_heat_mj - burned_heat_mj).max(0.0), 6),
    )?;
    Ok(())
}

fn charge_exchanger(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entity: &mut Map<String, Value>,
    building: &BuildingDefinition,
    energy_mj: f64,
    buffer_limit: f64,
) -> anyhow::Result<f64> {
    if energy_mj <= EPSILON {
        return Ok(0.0);
    }
    let cell_energy_mj = accumulator_energy_mj(state)?;
    let stored = stored_energy(entity, building).min(cell_energy_mj);
    let active_cells = if stored > EPSILON { 1.0 } else { 0.0 };
    let queued_cells = (item_amount(entity, "inputs", "accumulator") + EPSILON).floor();
    let usable_cells = (active_cells + queued_cells).min(item_output_free(
        entity,
        building,
        "charged_accumulator",
        buffer_limit,
    ));
    if usable_cells < 1.0 {
        return Ok(0.0);
    }
    let applied_energy_mj = energy_mj
        .max(0.0)
        .min((usable_cells * cell_energy_mj - stored).max(0.0));
    if applied_energy_mj <= EPSILON {
        return Ok(0.0);
    }
    let total_energy_mj = stored + applied_energy_mj;
    let completed = usable_cells.min(((total_energy_mj + EPSILON) / cell_energy_mj).floor());
    let remaining_energy_mj = (total_energy_mj - completed * cell_energy_mj).max(0.0);
    let residual = if remaining_energy_mj > EPSILON {
        remaining_energy_mj
    } else {
        0.0
    };
    let touched_cells = completed + if residual > EPSILON { 1.0 } else { 0.0 };
    let consumed_cells = queued_cells.min((touched_cells - active_cells).max(0.0));
    if consumed_cells > 0.0 {
        set_item_amount(
            entity,
            "inputs",
            "accumulator",
            queued_cells - consumed_cells,
        )?;
    }
    let previous = item_amount(entity, "outputs", "charged_accumulator");
    set_item_amount(
        entity,
        "outputs",
        "charged_accumulator",
        (previous + completed).floor(),
    )?;
    add_total_produced(base, "charged_accumulator", completed)?;
    set_number(entity, "storedEnergyMj", rounded(residual, 6))?;
    set_number(entity, "progress", residual / cell_energy_mj)?;
    Ok(completed)
}

fn discharge_exchanger(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entity: &mut Map<String, Value>,
    building: &BuildingDefinition,
    energy_mj: f64,
    buffer_limit: f64,
) -> anyhow::Result<f64> {
    if energy_mj <= EPSILON {
        return Ok(0.0);
    }
    let cell_energy_mj = accumulator_energy_mj(state)?;
    let stored = stored_energy(entity, building).min(cell_energy_mj);
    let active_cells = if stored > EPSILON { 1.0 } else { 0.0 };
    let queued_cells = (item_amount(entity, "inputs", "charged_accumulator") + EPSILON).floor();
    let usable_cells = (active_cells + queued_cells).min(item_output_free(
        entity,
        building,
        "accumulator",
        buffer_limit,
    ));
    if usable_cells < 1.0 {
        return Ok(0.0);
    }
    let available_energy_mj = stored + (usable_cells - active_cells).max(0.0) * cell_energy_mj;
    let applied_energy_mj = energy_mj.max(0.0).min(available_energy_mj);
    if applied_energy_mj <= EPSILON {
        return Ok(0.0);
    }
    let energy_needed_after_current = (applied_energy_mj - stored).max(0.0);
    let loaded_cells = queued_cells.min(if energy_needed_after_current > EPSILON {
        ((energy_needed_after_current - EPSILON).max(0.0) / cell_energy_mj).ceil()
    } else {
        0.0
    });
    let remaining_energy_mj = (stored + loaded_cells * cell_energy_mj - applied_energy_mj).max(0.0);
    let residual = if remaining_energy_mj > EPSILON {
        remaining_energy_mj
    } else {
        0.0
    };
    let completed =
        (active_cells + loaded_cells - if residual > EPSILON { 1.0 } else { 0.0 }).max(0.0);
    if loaded_cells > 0.0 {
        set_item_amount(
            entity,
            "inputs",
            "charged_accumulator",
            queued_cells - loaded_cells,
        )?;
    }
    let previous = item_amount(entity, "outputs", "accumulator");
    set_item_amount(
        entity,
        "outputs",
        "accumulator",
        (previous + completed).floor(),
    )?;
    add_total_produced(base, "accumulator", completed)?;
    set_number(entity, "storedEnergyMj", rounded(residual, 6))?;
    set_number(
        entity,
        "progress",
        if residual > EPSILON {
            1.0 - residual / cell_energy_mj
        } else {
            0.0
        },
    )?;
    Ok(completed)
}

fn material_delivery_items(state: &CoreState, entity: &Map<String, Value>) -> Vec<String> {
    let mut items = Vec::new();
    let mut append = |item_id: &str| {
        if state.catalog.items.contains_key(item_id) && !items.iter().any(|id| id == item_id) {
            items.push(item_id.to_owned());
        }
    };
    let mut used_slots = false;
    if let Some(slots) = entity.get("deliverySlots").and_then(Value::as_array) {
        used_slots = true;
        for slot in slots.iter().take(3).filter_map(Value::as_object) {
            if string_at(slot, "mode") == Some("disabled") {
                continue;
            }
            if let Some(item_id) = string_at(slot, "itemId") {
                append(item_id);
            }
        }
    }
    if !used_slots && let Some(legacy) = entity.get("deliveryItemIds").and_then(Value::as_array) {
        for item_id in legacy.iter().filter_map(Value::as_str).take(3) {
            append(item_id);
        }
    }
    items
}

fn material_delivery_hub_stays_awake(
    state: &CoreState,
    base: &Map<String, Value>,
    entity: &Value,
) -> bool {
    let Some(entity) = entity.as_object() else {
        return true;
    };
    let Some(inputs) = entity.get("inputs").and_then(Value::as_object) else {
        return true;
    };
    if inputs.values().any(|value| {
        value
            .as_f64()
            .is_none_or(|amount| !amount.is_finite() || amount != 0.0)
    }) {
        return true;
    }
    let Some(slots) = entity.get("deliverySlots").and_then(Value::as_array) else {
        // Legacy/opaque slot layouts retain the exact full-scan behavior.
        return true;
    };
    if slots.len() != 3 {
        return true;
    }
    let mut items = Vec::new();
    for slot in slots {
        let Some(slot) = slot.as_object() else {
            return true;
        };
        if slot.keys().any(|key| key.starts_with("mod:")) {
            return true;
        }
        let mode = string_at(slot, "mode");
        let item_id = slot.get("itemId");
        let configured = match mode {
            Some("disabled") if item_id.is_none_or(Value::is_null) => None,
            Some("auto") if item_id.is_none_or(Value::is_null) => None,
            Some("auto" | "manual") => {
                let Some(item_id) = item_id.and_then(Value::as_str) else {
                    return true;
                };
                if !state.catalog.items.contains_key(item_id) {
                    return true;
                }
                Some(item_id)
            }
            _ => return true,
        };
        if let Some(item_id) = configured
            && !items.contains(&item_id)
        {
            items.push(item_id);
        }
    }
    let Some(planet_id) = string_at(entity, "planetId") else {
        return true;
    };
    let Some(active_planet_id) = base.get("activePlanetId").and_then(Value::as_str) else {
        return true;
    };
    for item_id in items {
        if matches!(item_id, "logistics_drone" | "logistics_vessel") {
            continue;
        }
        let limit = match base
            .get("planetTrayItemLimits")
            .and_then(Value::as_object)
            .and_then(|limits| limits.get(planet_id))
        {
            Some(value) => {
                let Some(limit) = value.as_f64().filter(|limit| limit.is_finite()) else {
                    return true;
                };
                limit.floor().clamp(1_000.0, 100_000_000.0)
            }
            None => 1_000_000.0,
        };
        let tray = if planet_id == active_planet_id {
            let Some(tray) = base.get("tray").and_then(Value::as_object) else {
                return true;
            };
            Some(tray)
        } else {
            let Some(planet_trays) = base.get("planetTrays").and_then(Value::as_object) else {
                return true;
            };
            match planet_trays.get(planet_id) {
                Some(tray) => {
                    let Some(tray) = tray.as_object() else {
                        return true;
                    };
                    Some(tray)
                }
                None => None,
            }
        };
        let current = match tray.and_then(|tray| tray.get(item_id)) {
            Some(value) => {
                let Some(current) = value.as_f64().filter(|current| current.is_finite()) else {
                    return true;
                };
                current.floor()
            }
            None => 0.0,
        };
        if current >= limit {
            return true;
        }
    }
    false
}

#[derive(Clone, Copy)]
enum MaterialDeliveryDrainMode {
    Indexed,
    #[cfg(test)]
    FlatFull,
}

struct MaterialDeliveryDrainOutcome {
    scan: crate::material_delivery::MaterialDeliveryScan,
    written_entity_indices: Vec<usize>,
}

fn drain_material_delivery_hub_indices(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entities: &mut [Value],
    entity_indices: &[usize],
    seconds: f64,
) -> anyhow::Result<()> {
    let active_planet_id = base
        .get("activePlanetId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    for &entity_index in entity_indices {
        let Some(entity) = entities[entity_index].as_object() else {
            continue;
        };
        let planet_id = string_at(entity, "planetId").unwrap_or_default().to_owned();
        let items = material_delivery_items(state, entity);
        let amounts = items
            .iter()
            .map(|item_id| {
                (
                    item_id.clone(),
                    (item_amount(entity, "inputs", item_id) + EPSILON)
                        .floor()
                        .max(0.0),
                )
            })
            .collect::<Vec<_>>();
        let mut moved_by_item = Vec::with_capacity(amounts.len());
        let mut delivered = 0.0;
        for (item_id, amount) in amounts {
            if amount < 1.0 {
                moved_by_item.push((item_id, 0.0));
                continue;
            }
            if matches!(item_id.as_str(), "logistics_drone" | "logistics_vessel") {
                let fleet = base
                    .get_mut("portableFleet")
                    .and_then(Value::as_object_mut)
                    .ok_or_else(|| anyhow!("native portable fleet state is missing"))?;
                let current = finite_number(fleet.get(&item_id));
                set_number(fleet, &item_id, (current + amount + EPSILON).floor())?;
                delivered += amount;
                moved_by_item.push((item_id, amount));
                continue;
            }
            let limit = base
                .get("planetTrayItemLimits")
                .and_then(Value::as_object)
                .and_then(|limits| limits.get(&planet_id))
                .map(|value| {
                    finite_number(Some(value))
                        .floor()
                        .clamp(1_000.0, 100_000_000.0)
                })
                .unwrap_or(1_000_000.0);
            let tray = if planet_id == active_planet_id {
                base.get_mut("tray")
                    .and_then(Value::as_object_mut)
                    .ok_or_else(|| anyhow!("native active tray is missing"))?
            } else {
                let planet_trays = base
                    .get_mut("planetTrays")
                    .and_then(Value::as_object_mut)
                    .ok_or_else(|| anyhow!("native planet trays are missing"))?;
                planet_trays
                    .entry(planet_id.clone())
                    .or_insert_with(|| Value::Object(Map::new()))
                    .as_object_mut()
                    .ok_or_else(|| anyhow!("native planet tray is invalid"))?
            };
            let current = finite_number(tray.get(&item_id)).floor();
            let moved = amount.min((limit - current).max(0.0));
            if moved > 0.0 {
                set_number(tray, &item_id, (current + moved + EPSILON).floor())?;
            }
            delivered += moved;
            moved_by_item.push((item_id, moved));
        }
        let object = entity_object(&mut entities[entity_index])?;
        for (item_id, moved) in moved_by_item {
            if moved <= 0.0 {
                continue;
            }
            let current = item_amount(object, "inputs", &item_id);
            set_item_amount(object, "inputs", &item_id, (current - moved).max(0.0))?;
        }
        set_number(
            object,
            "utilization",
            if delivered > 0.0 { 1.0 } else { 0.0 },
        )?;
        set_number(
            object,
            "productionRate",
            if seconds > EPSILON {
                rounded(delivered * 60.0 / seconds, 2)
            } else {
                0.0
            },
        )?;
        set_number(object, "progress", if delivered > 0.0 { 1.0 } else { 0.0 })?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn drain_material_delivery_hubs(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entities: &mut [Value],
    runtime: &mut crate::material_delivery::MaterialDeliveryRuntime,
    seconds: f64,
    second_phase: bool,
    mode: MaterialDeliveryDrainMode,
) -> anyhow::Result<MaterialDeliveryDrainOutcome> {
    match mode {
        MaterialDeliveryDrainMode::Indexed => {}
        #[cfg(test)]
        MaterialDeliveryDrainMode::FlatFull => {
            let entity_indices = state.factory_topology.material_delivery_hub_indices.clone();
            drain_material_delivery_hub_indices(state, base, entities, &entity_indices, seconds)?;
            let scan = crate::material_delivery::MaterialDeliveryScan {
                selected_rows: entity_indices.len(),
                total_rows: entity_indices.len(),
                stable_rows_skipped: 0,
                dense_fallback: false,
                directory_fallback: false,
                full_scan: true,
            };
            runtime.record_flat_full_scan_for_test(scan);
            return Ok(MaterialDeliveryDrainOutcome {
                scan,
                written_entity_indices: entity_indices,
            });
        }
    }
    let selection = runtime.select(state, entities);
    let written_entity_indices = selection.entity_indices.clone();
    drain_material_delivery_hub_indices(state, base, entities, &selection.entity_indices, seconds)?;
    let scan = if second_phase {
        let stay_awake = selection
            .entity_indices
            .iter()
            .map(|&entity_index| {
                (
                    entity_index,
                    material_delivery_hub_stays_awake(state, base, &entities[entity_index]),
                )
            })
            .collect::<Vec<_>>();
        runtime.commit_second_phase(selection, &stay_awake)?
    } else {
        runtime.commit_first_phase(selection)
    };
    Ok(MaterialDeliveryDrainOutcome {
        scan,
        written_entity_indices,
    })
}

fn prepare_time_warp(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entities: &mut [Value],
) -> anyhow::Result<Option<usize>> {
    let controller_id = base
        .get("timeWarp")
        .and_then(Value::as_object)
        .and_then(|time_warp| string_at(time_warp, "controllerEntityId"))
        .map(str::to_owned);
    let controller_index = controller_id
        .as_deref()
        .and_then(|id| state.entity_index.get(id).copied())
        .filter(|index| state.factory_topology.time_warp_indices.contains(index));
    let simulation_speed = base
        .get("settings")
        .and_then(Value::as_object)
        .and_then(|settings| settings.get("simulationSpeed"))
        .map(|value| finite_number(Some(value)))
        .unwrap_or(1.0);
    let time_warp = base
        .get_mut("timeWarp")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native time-warp state is missing"))?;
    if controller_index.is_none() {
        time_warp.insert("controllerEntityId".to_owned(), Value::Null);
        time_warp.insert("enabled".to_owned(), Value::Bool(false));
    }
    set_number(time_warp, "effectiveMultiplier", simulation_speed)?;
    set_number(time_warp, "requiredPowerKw", 0.0)?;
    set_number(time_warp, "allocatedPowerKw", 0.0)?;
    for &entity_index in &state.factory_topology.time_warp_indices {
        let entity = entities[entity_index]
            .as_object_mut()
            .ok_or_else(|| anyhow!("native time-warp controller is invalid"))?;
        set_number(entity, "powerInputKw", 0.0)?;
        set_number(entity, "powerFactor", 0.0)?;
        set_number(entity, "utilization", 0.0)?;
        set_number(entity, "productionRate", 0.0)?;
    }
    Ok(controller_index)
}

fn time_warp_required_power_kw(multiplier: f64) -> Option<f64> {
    if !multiplier.is_finite()
        || multiplier.fract().abs() > f64::EPSILON
        || multiplier < 4.0
        || multiplier + 1.0 > 308.0
    {
        return None;
    }
    let power = 10_f64.powf(multiplier + 1.0);
    power.is_finite().then_some(power)
}

fn maximum_stable_time_warp_multiplier(
    available_power_kw: f64,
    requested_multiplier: f64,
) -> Option<f64> {
    if !available_power_kw.is_finite()
        || available_power_kw < 100_000.0
        || !requested_multiplier.is_finite()
        || requested_multiplier.fract().abs() > f64::EPSILON
        || requested_multiplier < 5.0
    {
        return None;
    }
    let supported = (available_power_kw.log10() - 1.0 + 1e-12).floor().max(4.0);
    Some(requested_multiplier.min(supported))
}

fn settle_post_route_station_mode_transition(
    state: &CoreState,
    transition_runtime: &mut std::sync::Arc<crate::system_space_station::ModeTransitionRuntime>,
    entities: &mut [Value],
    route_ledger: &crate::station_route_ledger::StationRouteLedger,
) -> anyhow::Result<(bool, crate::system_space_station::ModeTransitionScan)> {
    crate::system_space_station::settle_mode_transitions_with_scan(
        state,
        std::sync::Arc::make_mut(transition_runtime),
        entities,
        route_ledger,
    )
}

#[allow(clippy::too_many_arguments)]
fn refresh_station_mode_dependent_directories(
    state: &CoreState,
    base: &Map<String, Value>,
    entities: &[Value],
    topology_changed: bool,
    local_step_directory: &mut std::sync::Arc<crate::local_logistics::LocalPeerDirectory>,
    quantum_step_runtime: &mut crate::quantum_logistics::QuantumLogisticsDirectory,
    interstellar_peer_directory: &mut std::sync::Arc<
        crate::interstellar_logistics::InterstellarPeerDirectory,
    >,
    interstellar_route_activity: &mut std::sync::Arc<
        crate::interstellar_logistics::InterstellarRouteActivity,
    >,
) -> anyhow::Result<()> {
    crate::local_logistics::refresh_step_directory_after_topology_change(
        entities,
        &state.factory_topology.station_indices,
        topology_changed,
        local_step_directory,
    )?;
    crate::interstellar_logistics::refresh_route_activity_after_topology_change(
        entities,
        topology_changed,
        interstellar_route_activity,
    );
    crate::interstellar_logistics::refresh_peer_directory(
        state,
        base,
        entities,
        topology_changed,
        interstellar_peer_directory,
        interstellar_route_activity,
    );
    if topology_changed {
        *quantum_step_runtime =
            crate::quantum_logistics::QuantumLogisticsDirectory::build(state, entities);
    }
    Ok(())
}

// Keep each mutable runtime dependency explicit at the candidate boundary;
// bundling them would obscure which wake cache is committed only on success.
struct SimulateStepOutcome {
    station_mode_topology_changed: bool,
    writer_events: SealedFactoryWriterEvents,
}

#[allow(clippy::too_many_arguments)]
fn simulate_step(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entities: &mut [Value],
    belt_runtime: &mut crate::belts::BeltRuntime,
    belt_routes: &crate::belts::PreparedRoutes,
    logistics_buffer_runtime: &mut std::sync::Arc<crate::logistics_buffers::LogisticsBufferRuntime>,
    material_delivery_runtime: &mut std::sync::Arc<
        crate::material_delivery::MaterialDeliveryRuntime,
    >,
    material_delivery_mode: MaterialDeliveryDrainMode,
    ordinary_production_runtime: &mut std::sync::Arc<
        crate::ordinary_production::OrdinaryProductionRuntime,
    >,
    planet_metrics_runtime: &mut std::sync::Arc<PlanetMetricsRuntime>,
    planet_metric_mode: PlanetMetricProbeMode,
    power_probe_runtime: &mut std::sync::Arc<PowerProbeRuntime>,
    power_probe_mode: PowerProbeMode,
    local_step_directory: &mut std::sync::Arc<crate::local_logistics::LocalPeerDirectory>,
    quantum_logistics_directory: &mut std::sync::Arc<
        crate::quantum_logistics::QuantumLogisticsDirectory,
    >,
    construction_runtime: &mut std::sync::Arc<crate::construction::ConstructionRuntime>,
    station_mode_transition_runtime: &mut std::sync::Arc<
        crate::system_space_station::ModeTransitionRuntime,
    >,
    quantum_transition_runtime: &mut std::sync::Arc<
        crate::quantum_logistics::QuantumTransitionRuntime,
    >,
    interstellar_peer_directory: &mut std::sync::Arc<
        crate::interstellar_logistics::InterstellarPeerDirectory,
    >,
    interstellar_route_activity: &mut std::sync::Arc<
        crate::interstellar_logistics::InterstellarRouteActivity,
    >,
    execution_diagnostics: &mut FactoryExecutionDiagnosticsBuilder,
    runtime: &DeterministicRuntime,
    seconds: f64,
    isolate_construction_automation: bool,
) -> anyhow::Result<SimulateStepOutcome> {
    execution_diagnostics.begin_step(seconds);
    let profile_enabled = crate::profile_evidence::profile_environment_enabled();
    let mut profile_checkpoint = profile_enabled.then(std::time::Instant::now);
    let mut writer_events = FactoryWriterEvents::new(state.revision, entities.len());
    let mut planet_metric_directory_fallback = false;
    macro_rules! profile_mark {
        ($label:literal) => {
            if let Some(checkpoint) = profile_checkpoint.as_mut() {
                eprintln!(
                    "DSP_NATIVE_CORE_PROFILE\t{}\t{:.3}",
                    $label,
                    checkpoint.elapsed().as_secs_f64() * 1_000.0
                );
                *checkpoint = std::time::Instant::now();
            }
        };
    }
    if profile_enabled {
        eprintln!(
            "DSP_NATIVE_CORE_PROFILE\tfactory-power-probe-workers\t{}",
            runtime.worker_limit()
        );
    }
    let elapsed_before_step = finite_number(base.get("elapsedSeconds"));
    let projected_elapsed = rounded(elapsed_before_step + seconds, 4);
    let first_quantum_boundary = (elapsed_before_step / 5.0).floor() as u64 + 1;
    let last_quantum_boundary = (projected_elapsed / 5.0).floor() as u64;
    let crossed_quantum_boundary = first_quantum_boundary <= last_quantum_boundary;
    // The TypeScript engine builds its quantum endpoint lookup before this
    // simulation call. A tower that completes attachment at a boundary is
    // intentionally absent from uploads until the next call refreshes that
    // lookup, even when this call crosses more than one boundary.
    let quantum_step_runtime = std::sync::Arc::make_mut(quantum_logistics_directory);
    let indexed_quantum_endpoint_indices = quantum_step_runtime
        .endpoint_indices(state, entities)
        .map(<[usize]>::to_vec)
        .unwrap_or_else(|| {
            state
                .factory_topology
                .quantum_endpoint_indices
                .iter()
                .copied()
                .filter(|&index| {
                    entities[index]
                        .as_object()
                        .is_some_and(|entity| string_at(entity, "quantumMode") == Some("quantum"))
                })
                .collect()
        });
    let quantum_runtime_bandwidth =
        quantum_step_runtime.legacy_runtime_bandwidth(state, base, entities);
    profile_mark!("static-step-indexes");
    let time_warp_controller = prepare_time_warp(state, base, entities)?;
    writer_events.record_rows(
        FactoryWriterDomain::Inventory,
        &state.factory_topology.time_warp_indices,
    )?;
    crate::global_progress::advance_exploration(state, base, seconds)?;
    crate::global_progress::advance_handcraft(state, base, seconds)?;
    crate::dyson::advance_environment(base, seconds)?;
    writer_events.record_global(FactoryWriterDomain::Research);
    writer_events.record_global(FactoryWriterDomain::Dyson);
    crate::interstellar_logistics::refresh_peer_directory(
        state,
        base,
        entities,
        false,
        interstellar_peer_directory,
        interstellar_route_activity,
    );
    profile_mark!("time-warp-and-dyson-environment");
    // The imported/rebuilt directory starts with every station dirty. After a
    // successful step it retains only the route endpoints and collectors that
    // actually wrote transient runtime display fields, so dormant stations do
    // not impose an O(all stations) reset on every simulated second.
    let local_step_runtime = std::sync::Arc::make_mut(local_step_directory);
    let runtime_reset_station_indices = local_step_runtime.runtime_reset_station_indices().to_vec();
    crate::local_logistics::reset_runtime_for_indices(entities, &runtime_reset_station_indices)?;
    writer_events.record_rows(
        FactoryWriterDomain::Logistics,
        &runtime_reset_station_indices,
    )?;
    if profile_enabled {
        eprintln!(
            "DSP_NATIVE_CORE_PROFILE\tlocal-runtime-reset-active\t{}/{}",
            runtime_reset_station_indices.len(),
            state.factory_topology.station_indices.len(),
        );
    }
    profile_mark!("local-runtime-reset");
    profile_mark!("local-step-directory");
    let logistics_buffer_outcome = crate::logistics_buffers::settle_with_writer_rows(
        state,
        base,
        entities,
        std::sync::Arc::make_mut(logistics_buffer_runtime),
    )?;
    let logistics_buffer_scan = logistics_buffer_outcome.scan;
    writer_events.record_rows(
        FactoryWriterDomain::Inventory,
        &logistics_buffer_outcome.written_entity_indices,
    )?;
    execution_diagnostics.observe(
        FactoryScanStage::LogisticsBuffer,
        logistics_buffer_scan.selected_rows,
        logistics_buffer_scan.total_rows,
        logistics_buffer_scan.stable_rows_skipped,
        logistics_buffer_scan.dense_fallback,
        logistics_buffer_scan.directory_fallback,
        logistics_buffer_scan.full_scan,
    );
    planet_metric_directory_fallback |= logistics_buffer_scan.directory_fallback;
    if profile_enabled {
        eprintln!(
            "DSP_NATIVE_CORE_PROFILE\tordinary-buffer-active\t{}/{}\tskipped={}\tdense={}\tdirectory-fallback={}",
            logistics_buffer_scan.selected_rows,
            logistics_buffer_scan.total_rows,
            logistics_buffer_scan.stable_rows_skipped,
            logistics_buffer_scan.dense_fallback,
            logistics_buffer_scan.directory_fallback,
        );
    }
    profile_mark!("ordinary-logistics-buffers");
    // Only candidate-local wake vectors are mutable. Arc::make_mut preserves
    // the source revision's runtime cache if any later simulation stage fails.
    let buffer_changed_station_indices =
        crate::local_logistics::transfer_buffers(state, base, entities, local_step_runtime)?;
    writer_events.record_rows(
        FactoryWriterDomain::Inventory,
        &buffer_changed_station_indices,
    )?;
    local_step_runtime.wake_ready_from_changed_stations(&buffer_changed_station_indices);
    crate::interstellar_logistics::wake_dispatch_from_changed_stations(
        &buffer_changed_station_indices,
        interstellar_peer_directory,
        std::sync::Arc::make_mut(interstellar_route_activity),
    );
    crate::interstellar_logistics::wake_warper_refill_from_changed_stations(
        &buffer_changed_station_indices,
        std::sync::Arc::make_mut(interstellar_route_activity),
    );
    quantum_step_runtime.wake_from_stations(&buffer_changed_station_indices);
    profile_mark!("local-logistics-buffers");
    // Readiness, quantum reservations and downloads share one exact pre-
    // dispatch route snapshot. No route mutation occurs before dispatch, so
    // constructing it here removes two independent O(R) quantum scans.
    let mut step_route_ledger = crate::station_route_ledger::StationRouteLedger::build(
        state,
        entities,
        local_step_runtime,
        interstellar_route_activity.as_ref(),
    );
    let quantum_flush_scan = crate::quantum_logistics::flush_active_supply_buffers(
        state,
        base,
        entities,
        quantum_step_runtime,
        &step_route_ledger,
        quantum_runtime_bandwidth,
        false,
    )?;
    execution_diagnostics.observe(
        FactoryScanStage::Quantum,
        quantum_flush_scan.selected_rows,
        quantum_flush_scan.total_rows,
        quantum_flush_scan
            .total_rows
            .saturating_sub(quantum_flush_scan.selected_rows),
        quantum_flush_scan.dense_fallback,
        quantum_flush_scan.directory_fallback,
        quantum_flush_scan.dense_fallback || quantum_flush_scan.directory_fallback,
    );
    planet_metric_directory_fallback |= quantum_flush_scan.directory_fallback;
    crate::quantum_logistics::record_quantum_oactive_scan(
        crate::quantum_logistics::QuantumOactiveProfileStage::SupplyFlush,
        quantum_flush_scan,
    );
    if profile_enabled {
        eprintln!(
            "DSP_NATIVE_CORE_PROFILE\tquantum-flush-active\t{}/{}\tdense={}\tdirectory-fallback={}",
            quantum_flush_scan.selected_rows,
            quantum_flush_scan.total_rows,
            quantum_flush_scan.dense_fallback,
            quantum_flush_scan.directory_fallback,
        );
    }
    let quantum_flush_changed_station_indices =
        quantum_step_runtime.take_inventory_written_station_indices();
    writer_events.record_rows(
        FactoryWriterDomain::Quantum,
        &quantum_flush_changed_station_indices,
    )?;
    // Quantum upload can consume a remote-supply output while freeing the
    // same station's local-demand capacity. Wake both reverse graphs from the
    // exact changed endpoint set; the readiness probes still decide whether
    // the scalar inventory change made either side active.
    local_step_runtime.wake_ready_from_changed_stations(&quantum_flush_changed_station_indices);
    crate::interstellar_logistics::wake_dispatch_from_changed_stations(
        &quantum_flush_changed_station_indices,
        interstellar_peer_directory,
        std::sync::Arc::make_mut(interstellar_route_activity),
    );
    crate::belts::wake_tracked_station_sources(
        state,
        entities,
        belt_runtime,
        belt_routes,
        &buffer_changed_station_indices,
    )?;
    crate::belts::wake_tracked_station_sources(
        state,
        entities,
        belt_runtime,
        belt_routes,
        &quantum_flush_changed_station_indices,
    )?;
    profile_mark!("quantum-supply-buffers");
    profile_mark!("belt-route-index");
    let mut belt_changed_entity_indices = Vec::new();
    crate::belts::transfer_with_bandwidth(
        state,
        base,
        entities,
        belt_runtime,
        belt_routes,
        quantum_runtime_bandwidth,
        seconds,
        true,
        None,
        seconds,
        &mut belt_changed_entity_indices,
    )?;
    writer_events.record_rows(FactoryWriterDomain::Belt, &belt_changed_entity_indices)?;
    crate::local_logistics::wake_transfer_buffers_from_changed_entities(
        entities,
        &belt_changed_entity_indices,
        local_step_runtime,
    )?;
    std::sync::Arc::make_mut(logistics_buffer_runtime)
        .wake_from_changed_entities(state, &belt_changed_entity_indices);
    std::sync::Arc::make_mut(material_delivery_runtime)
        .wake_from_changed_entities(state, &belt_changed_entity_indices);
    std::sync::Arc::make_mut(ordinary_production_runtime)
        .wake_from_changed_entities(&belt_changed_entity_indices);
    local_step_runtime.wake_ready_from_changed_stations(&belt_changed_entity_indices);
    crate::interstellar_logistics::wake_dispatch_from_changed_stations(
        &belt_changed_entity_indices,
        interstellar_peer_directory,
        std::sync::Arc::make_mut(interstellar_route_activity),
    );
    crate::interstellar_logistics::wake_warper_refill_from_changed_stations(
        &belt_changed_entity_indices,
        std::sync::Arc::make_mut(interstellar_route_activity),
    );
    quantum_step_runtime.wake_from_stations(&belt_changed_entity_indices);
    profile_mark!("belt-input-transfer");
    let belt_reservation = crate::belts::reserve(state, base, entities, belt_runtime, belt_routes)?;
    let production_step_runtime = std::sync::Arc::make_mut(ordinary_production_runtime);
    production_step_runtime
        .wake_from_output_credits(belt_reservation.output_credits.active_source_items());
    // A research row remains awake and keeps its persisted settlement order.
    // Other dormant producer/miner rows may stay sparse only when the current
    // post-belt-input material snapshot proves that no research boundary can
    // be crossed in this step. Any uncertainty retains the legacy full scan.
    let research_boundary = research_completion_boundary_proof(state, base, entities, seconds);
    let ordinary_production_selection =
        production_step_runtime.select(state, entities, research_boundary.requires_full_scan());
    profile_mark!("belt-reservation");
    crate::interstellar_logistics::run_orbital_collectors(
        state,
        base,
        entities,
        seconds,
        &belt_reservation.output_credits,
    )?;
    if state.factory_topology.orbital_collector_full_scan_required {
        planet_metric_directory_fallback = true;
    } else {
        writer_events.record_rows(
            FactoryWriterDomain::Production,
            &state.factory_topology.orbital_collector_indices,
        )?;
    }
    crate::interstellar_logistics::wake_orbital_supply_demands(
        interstellar_peer_directory,
        std::sync::Arc::make_mut(interstellar_route_activity),
    );
    let material_delivery_outcome = drain_material_delivery_hubs(
        state,
        base,
        entities,
        std::sync::Arc::make_mut(material_delivery_runtime),
        seconds,
        false,
        material_delivery_mode,
    )?;
    execution_diagnostics.observe(
        FactoryScanStage::MaterialDelivery,
        material_delivery_outcome.scan.selected_rows,
        material_delivery_outcome.scan.total_rows,
        material_delivery_outcome.scan.stable_rows_skipped,
        material_delivery_outcome.scan.dense_fallback,
        material_delivery_outcome.scan.directory_fallback,
        material_delivery_outcome.scan.full_scan,
    );
    writer_events.record_rows(
        FactoryWriterDomain::Inventory,
        &material_delivery_outcome.written_entity_indices,
    )?;
    planet_metric_directory_fallback |= material_delivery_outcome.scan.directory_fallback;
    if profile_enabled {
        eprintln!(
            "DSP_NATIVE_CORE_PROFILE\tmaterial-delivery-active-pre\t{}/{}\tskipped={}\tdense={}\tdirectory-fallback={}",
            material_delivery_outcome.scan.selected_rows,
            material_delivery_outcome.scan.total_rows,
            material_delivery_outcome.scan.stable_rows_skipped,
            material_delivery_outcome.scan.dense_fallback,
            material_delivery_outcome.scan.directory_fallback,
        );
    }
    let reception = crate::dyson::calculate_reception(state, base, entities)?;
    profile_mark!("collectors-delivery-and-reception");
    let planet_ids = state
        .catalog
        .planets
        .iter()
        .map(|planet| planet.id.clone())
        .collect::<Vec<_>>();
    let profiles = state
        .catalog
        .planets
        .iter()
        .map(|planet| profile_for(base, &planet.id, &planet.system_id))
        .collect::<anyhow::Result<Vec<_>>>()?;
    let (_, power_demand_multiplier) = difficulty_multipliers(base);
    let production_buffer_limit = normalized_buffer_limit(
        base.get("settings")
            .and_then(Value::as_object)
            .and_then(|value| value.get("productionBufferLimit")),
    );
    let mut grids = vec![GridRuntime::default(); planet_ids.len() * GRID_IDS.len()];
    let grid_slot = |planet: usize, grid: usize| planet * GRID_IDS.len() + grid;

    let prepared_power_sources = collect_power_sources_with_runtime(
        runtime,
        state,
        entities,
        &reception,
        &profiles,
        production_buffer_limit,
        seconds,
        power_probe_runtime,
        power_probe_mode,
        &mut grids,
    )?;
    let power_probe_scan = prepared_power_sources.scan;
    let power_source_settlement_indices = prepared_power_sources.settlement_entity_indices;
    execution_diagnostics.observe(
        FactoryScanStage::PowerProbe,
        power_probe_scan.selected_rows,
        power_probe_scan.total_rows,
        power_probe_scan.stable_rows_skipped,
        power_probe_scan.dense_fallback,
        power_probe_scan.directory_fallback,
        power_probe_scan.full_scan,
    );
    if profile_enabled {
        eprintln!(
            "DSP_NATIVE_CORE_PROFILE\tpower-source-active\t{}/{}\tskipped={}\treplay={}\tdense={}\tdirectory-fallback={}",
            power_probe_scan.selected_rows,
            power_probe_scan.total_rows,
            power_probe_scan.stable_rows_skipped,
            power_probe_scan.compact_replay_rows,
            power_probe_scan.dense_fallback,
            power_probe_scan.directory_fallback,
        );
    }
    // A full-output miner has no demand, but the legacy probe still counts it
    // as connected/disconnected. Preserve that display metric with a static
    // per-grid aggregate while the row sleeps; any output-credit or belt
    // inventory event wakes the exact miner before it can produce again.
    for (grid_slot, &count) in ordinary_production_selection
        .dormant_positive_veins_by_grid
        .iter()
        .enumerate()
    {
        if count == 0 {
            continue;
        }
        if grids[grid_slot].has_power_source {
            grids[grid_slot].connected_entities += count;
        } else {
            grids[grid_slot].disconnected_entities += count;
        }
    }
    profile_mark!("power-source-index");

    // Local and interstellar readiness consume the same immutable route
    // snapshot already used by the quantum pre-flush. The active queues
    // preserve persisted row order; a dense set falls back to the complete
    // station ledger without changing dispatch fairness or command authority.
    if profile_enabled {
        let scan = step_route_ledger.scan();
        eprintln!(
            "DSP_NATIVE_CORE_PROFILE\tstation-route-ledger-ready\t{}/{}\tdense={}\torder-input={}\torder-duplicates={}\torder-fallback={}",
            scan.selected_demands,
            scan.total_candidate_rows,
            scan.dense_fallback,
            scan.active_order_input_rows,
            scan.active_order_duplicate_rows,
            scan.active_order_fallback,
        );
    }
    let mut ready_stations = crate::local_logistics::ready_station_indices(
        state,
        base,
        entities,
        local_step_runtime,
        &step_route_ledger,
    )?;
    profile_mark!("local-ready-stations");
    ready_stations.extend(crate::interstellar_logistics::ready_station_indices(
        state,
        base,
        entities,
        interstellar_peer_directory,
        std::sync::Arc::make_mut(interstellar_route_activity),
        &step_route_ledger,
    )?);
    profile_mark!("interstellar-ready-stations");
    ready_stations.extend(indexed_quantum_endpoint_indices.iter().copied().filter(
        |&entity_index| {
            state
                .symbols
                .resolve(state.entities.buildings[entity_index])
                == Some("interstellar_logistics_station")
        },
    ));
    let mut ready_logistics_station_indices = ready_stations.iter().copied().collect::<Vec<_>>();
    ready_logistics_station_indices.sort_unstable();
    let construction_power_plan = std::sync::Arc::make_mut(construction_runtime).power_demand_plan(
        state,
        base,
        entities,
        &state.factory_topology.construction_center_indices,
        power_demand_multiplier,
    );
    planet_metric_directory_fallback |= construction_power_plan.directory_fallback;
    ready_stations.extend(crate::galactic_exports::ready_exporter_indices(
        state, entities,
    ));
    ready_stations.extend(crate::system_space_station::active_power_consumers(
        state, base, entities,
    ));
    let mut ready_station_indices = ready_stations.into_iter().collect::<Vec<_>>();
    ready_station_indices.sort_unstable();
    let mut disconnected_power_factor_indices = Vec::new();
    let industrial_speed = industrial_speed_multiplier(base);
    let research_speed = research_speed_multiplier(base);
    let prepared_power_demands = prepare_power_demand_probes_with_runtime(
        runtime,
        state,
        base,
        entities,
        &profiles,
        &ready_station_indices,
        &ordinary_production_selection.vein_indices,
        &ordinary_production_selection.machine_indices,
        production_buffer_limit,
        power_demand_multiplier,
        industrial_speed,
        research_speed,
        seconds,
    );
    if profile_enabled {
        let scheduler = prepared_power_demands.scheduler;
        eprintln!(
            "DSP_NATIVE_CORE_PROFILE\tpartitioned-power-demand-prepare\tactive={}/3\twork-items={}\tselected-workers={}\tobserved-workers={}\tparallel={}",
            scheduler.active_partitions,
            scheduler.work_items,
            scheduler.selected_worker_count,
            scheduler.observed_worker_count,
            scheduler.parallel,
        );
    }
    profile_mark!("power-demand-prepare");
    // Stable validation is the transaction boundary. Even if workers finish
    // in a different order, the first visible error remains ready station,
    // then vein, then ordinary machine, exactly as before this scheduler.
    let ready_station_probes = prepared_power_demands
        .ready_stations
        .into_iter()
        .collect::<anyhow::Result<Vec<_>>>()?;
    let mut vein_probes = Vec::with_capacity(prepared_power_demands.veins.len());
    for probe in prepared_power_demands.veins {
        if let Some(probe) = probe? {
            vein_probes.push(probe);
        }
    }
    let mut machine_probes = Vec::with_capacity(prepared_power_demands.machines.len());
    for probe in prepared_power_demands.machines {
        if let Some(probe) = probe? {
            machine_probes.push(probe);
        }
    }
    // Sleeping is deliberately one quiescent pass behind production. A row
    // that was runnable at this pre-settlement probe must be selected once
    // more even when this pass consumes its last input or fills its output.
    // That following pass executes the legacy zero-field normalization before
    // the row can leave the wake set.
    let pre_step_active_vein_indices = vein_probes
        .iter()
        .filter(|probe| probe.demand_active)
        .map(|probe| probe.entity_index)
        .collect::<Vec<_>>();
    let pre_step_active_machine_indices = machine_probes
        .iter()
        .filter(|probe| probe.demand_active)
        .map(|probe| probe.entity_index)
        .collect::<Vec<_>>();

    let use_construction_aggregates = construction_power_plan.aggregate_candidate
        && construction_power_aggregation_is_exact(
            &[&ready_station_probes, &vein_probes, &machine_probes],
            &construction_power_plan.groups,
            grids.len(),
        );
    std::sync::Arc::make_mut(construction_runtime)
        .use_aggregated_power_factors(use_construction_aggregates);
    let mut ready_station_probes = ready_station_probes;
    if !use_construction_aggregates && construction_power_plan.has_deficit {
        let center_probes = collect_indexed_power_probes_with_runtime(
            runtime,
            &state.factory_topology.construction_center_indices,
            |&entity_index| {
                probe_ready_station_demand(state, entities, power_demand_multiplier, entity_index)
            },
        );
        for probe in center_probes {
            ready_station_probes.push(probe?);
        }
        ready_station_probes.sort_unstable_by_key(|probe| probe.entity_index);
    }
    for probe in ready_station_probes {
        apply_power_demand_probe(probe, &mut grids, &mut disconnected_power_factor_indices);
    }
    if use_construction_aggregates {
        for group in construction_power_plan.groups.iter().copied() {
            apply_construction_power_group(
                group,
                &mut grids,
                &mut disconnected_power_factor_indices,
            );
        }
    }
    for probe in vein_probes {
        apply_power_demand_probe(probe, &mut grids, &mut disconnected_power_factor_indices);
    }
    profile_mark!("power-demand-index");
    for probe in machine_probes {
        apply_power_demand_probe(probe, &mut grids, &mut disconnected_power_factor_indices);
    }
    if profile_enabled {
        eprintln!(
            "DSP_NATIVE_CORE_PROFILE\tconstruction-power-demand\tgroups={}/{}\taggregated={}\tdirectory-fallback={}",
            construction_power_plan.groups.len(),
            state.factory_topology.construction_center_indices.len(),
            use_construction_aggregates,
            construction_power_plan.directory_fallback,
        );
    }
    profile_mark!("machine-power-demand-index");

    let mut power_factors = HashMap::<usize, f64>::new();
    let time_warp_enabled = base
        .get("timeWarp")
        .and_then(Value::as_object)
        .and_then(|time_warp| time_warp.get("enabled"))
        .and_then(Value::as_bool)
        == Some(true);
    let requested_time_warp = base
        .get("timeWarp")
        .and_then(Value::as_object)
        .map(|time_warp| finite_number(time_warp.get("requestedMultiplier")))
        .unwrap_or(0.0);
    let simulation_speed = base
        .get("settings")
        .and_then(Value::as_object)
        .map(|settings| finite_number(settings.get("simulationSpeed")))
        .unwrap_or(1.0);
    let time_warp_grid_slot = time_warp_controller.and_then(|entity_index| {
        let planet = state.factory_topology.entity_planet_indices[entity_index];
        let grid = state.factory_topology.entity_grid_indices[entity_index];
        (planet != usize::MAX && grid != usize::MAX)
            .then_some((grid_slot(planet, grid), entity_index))
    });
    for (runtime_index, runtime) in grids.iter_mut().enumerate() {
        let connected_demand = runtime
            .consumers
            .iter()
            .flat_map(|group| group.iter())
            .map(|consumer| consumer.demand_kw)
            .sum::<f64>();
        (runtime.base_generation_kw, runtime.generation_kw) =
            power_generation_capacity_in_js_order(runtime);
        runtime.regular_supplied_kw = connected_demand.min(runtime.generation_kw);
        runtime.supplied_kw = runtime.regular_supplied_kw;
        runtime.demand_kw = connected_demand + runtime.disconnected_demand_kw;
        if time_warp_enabled
            && let Some((controller_slot, controller_index)) = time_warp_grid_slot
            && controller_slot == runtime_index
        {
            let available = (runtime.generation_kw - runtime.regular_supplied_kw).max(0.0);
            let stable = maximum_stable_time_warp_multiplier(available, requested_time_warp);
            let effective = stable.unwrap_or(simulation_speed);
            let demand = time_warp_required_power_kw(stable.unwrap_or(4.0)).unwrap_or(100_000.0);
            let allocated = available.min(demand);
            runtime.demand_kw += demand;
            runtime.supplied_kw += allocated;
            runtime
                .power_input_by_entity
                .insert(controller_index, allocated);
            power_factors.insert(
                controller_index,
                if demand > EPSILON {
                    (allocated / demand).min(1.0)
                } else {
                    0.0
                },
            );
            if runtime.has_power_source {
                runtime.connected_entities += 1;
            } else {
                runtime.disconnected_entities += 1;
            }
            let time_warp = base
                .get_mut("timeWarp")
                .and_then(Value::as_object_mut)
                .ok_or_else(|| anyhow!("native time-warp state is missing"))?;
            set_number(time_warp, "effectiveMultiplier", effective)?;
            set_number(time_warp, "requiredPowerKw", demand)?;
            set_number(time_warp, "allocatedPowerKw", allocated)?;
            let controller = entities[controller_index]
                .as_object_mut()
                .ok_or_else(|| anyhow!("native time-warp controller is invalid"))?;
            set_number(controller, "powerInputKw", rounded(allocated, 2))?;
            set_number(
                controller,
                "powerFactor",
                if demand > EPSILON {
                    rounded(allocated / demand, 4)
                } else {
                    0.0
                },
            )?;
            set_number(
                controller,
                "utilization",
                if stable.is_some() { 1.0 } else { 0.0 },
            )?;
            set_number(controller, "productionRate", 0.0)?;
        }
        runtime.factor = if runtime.demand_kw <= EPSILON {
            1.0
        } else {
            (runtime.supplied_kw / runtime.demand_kw).min(1.0)
        };
        let missing_kw = (runtime.supplied_kw - runtime.base_generation_kw).max(0.0);
        let dispatch_candidates = runtime.dispatch_candidates.clone();
        allocate_power_by_priority(
            &dispatch_candidates,
            missing_kw,
            &mut runtime.power_output_by_entity,
        );
        for candidate in &dispatch_candidates {
            let output = runtime
                .power_output_by_entity
                .get(&candidate.entity_index)
                .copied()
                .unwrap_or(0.0);
            match candidate.kind {
                DispatchKind::Thermal => runtime.thermal_generation_kw += output,
                DispatchKind::Fusion => runtime.fusion_generation_kw += output,
                DispatchKind::ArtificialStar => runtime.artificial_star_generation_kw += output,
                DispatchKind::Accumulator | DispatchKind::Exchanger => {
                    runtime.storage_discharge_kw += output;
                }
            }
        }
        let mut surplus_kw = (runtime.base_generation_kw - runtime.demand_kw).max(0.0);
        let exchanger_charge_candidates = runtime.exchanger_charge_candidates.clone();
        let exchanger_charge = allocate_power(
            &exchanger_charge_candidates,
            surplus_kw,
            &mut runtime.power_input_by_entity,
        );
        runtime.storage_charge_kw += exchanger_charge;
        surplus_kw -= exchanger_charge;
        let accumulator_charge_candidates = runtime.accumulator_charge_candidates.clone();
        let accumulator_charge = allocate_power(
            &accumulator_charge_candidates,
            surplus_kw,
            &mut runtime.power_input_by_entity,
        );
        runtime.storage_charge_kw += accumulator_charge;
        let mut remaining = runtime.regular_supplied_kw.max(0.0);
        for priority in [3_usize, 2, 1] {
            let demand = runtime.consumers[priority]
                .iter()
                .map(|consumer| consumer.demand_kw)
                .sum::<f64>();
            let factor = if demand <= EPSILON {
                1.0
            } else {
                (remaining / demand).min(1.0)
            };
            for consumer in &runtime.consumers[priority] {
                power_factors.insert(consumer.entity_index, factor);
            }
            remaining = (remaining - demand * factor).max(0.0);
        }
    }
    profile_mark!("power-allocation");
    for entity_index in disconnected_power_factor_indices {
        power_factors.insert(entity_index, 0.0);
    }
    profile_mark!("disconnected-power-factors");

    let (difficulty_mining_multiplier, _) = difficulty_multipliers(base);
    let research_base = if completed_tech(base, "mining_speed_3") {
        3.0
    } else if completed_tech(base, "mining_speed_2") {
        2.0
    } else if completed_tech(base, "mining_speed_1") {
        1.5
    } else {
        1.0
    };
    let mining_research_multiplier =
        research_base * (1.0 + vein_utilization_level(base) * 0.1) * difficulty_mining_multiplier;
    let vein_level = vein_utilization_level(base);
    let finite_consumption_tenths = (10.0 - vein_level.min(10.0)).max(0.0).floor();
    let infinite_resource_mode = base
        .get("settings")
        .and_then(Value::as_object)
        .and_then(|settings| settings.get("resourceMode"))
        .and_then(Value::as_str)
        == Some("infinite");
    let vein_context = VeinSettlementContext {
        production_buffer_limit,
        mining_research_multiplier,
        vein_level,
        finite_consumption_tenths,
        infinite_resource_mode,
        seconds,
    };
    let vein_settlement_outcomes = collect_vein_settlement_outcomes(
        runtime,
        &ordinary_production_selection.vein_indices,
        &VeinProbeEnvironment {
            state,
            entities,
            profiles: &profiles,
            grids: &grids,
            power_factors: &power_factors,
            output_credits: &belt_reservation.output_credits,
            context: vein_context,
        },
    );
    let mut vein_settlement_outcomes = vein_settlement_outcomes.into_iter().peekable();
    profile_mark!("vein-settlement-probes");
    let local_machine_settlement_plan = plan_local_machine_settlement(
        state,
        runtime,
        &ordinary_production_selection.machine_indices,
    );
    if profile_enabled {
        eprintln!(
            "DSP_NATIVE_CORE_PROFILE\tfactory-local-machine-settlement\tworkers={}\tparallel={}\tfallback={}\tbarriers={}\tbatches={}",
            runtime.worker_limit(),
            local_machine_settlement_plan.parallel_entity_count,
            local_machine_settlement_plan.serial_fallback_count,
            local_machine_settlement_plan.global_barrier_count,
            local_machine_settlement_plan.batches.len(),
        );
    }
    let mut local_machine_settlement_batches = local_machine_settlement_plan.batches.into_iter();
    let mut local_machine_settlement_indices = local_machine_settlement_batches
        .next()
        .map(|batch| batch.entity_indices.into_iter().peekable());
    if local_machine_settlement_batches.next().is_some() {
        bail!("native local machine settlement planner emitted multiple aggregate batches");
    }
    let mut local_machine_settlement_tasks =
        Vec::with_capacity(local_machine_settlement_plan.parallel_entity_count);
    let mut machine_production_events = local_machine_settlement_indices
        .is_some()
        .then(Vec::<MachineProductionEvent>::new);
    profile_mark!("machine-local-settlement-plan");
    let renewable_power_facility_patches = collect_renewable_power_facility_patches_with_runtime(
        runtime,
        state,
        entities,
        &power_source_settlement_indices,
        &grids,
    )?;
    if profile_enabled {
        eprintln!(
            "DSP_NATIVE_CORE_PROFILE\tfactory-renewable-power-patches\tworkers={}\tcandidates={}",
            runtime.worker_limit(),
            renewable_power_facility_patches.len(),
        );
    }
    let mut renewable_power_facility_patches =
        renewable_power_facility_patches.into_iter().peekable();
    let mut produced_by_item = HashMap::<String, f64>::new();
    let mut dyson_launch_runtime = None;
    let has_galactic_material_exporter = state.factory_topology.has_galactic_material_exporter;
    let research_entity_indexes = &state.factory_topology.research_entity_indices;
    let mut reset_research_progress_before_next_entity = false;

    let ordinary_settlement_indices = crate::ordinary_production::merge_settlement_indices(
        &power_source_settlement_indices,
        &ordinary_production_selection,
    );
    writer_events.record_rows(
        FactoryWriterDomain::Production,
        &ordinary_settlement_indices,
    )?;
    writer_events.record_global(FactoryWriterDomain::Power);
    for &entity_index in &ordinary_settlement_indices {
        if reset_research_progress_before_next_entity {
            reset_indexed_research_machine_progress(entities, research_entity_indexes)?;
            reset_research_progress_before_next_entity = false;
        }
        if renewable_power_facility_patches
            .peek()
            .is_some_and(|patch| patch.entity_index < entity_index)
        {
            bail!("native renewable power facility patch order diverged");
        }
        if renewable_power_facility_patches
            .peek()
            .is_some_and(|patch| patch.entity_index == entity_index)
        {
            let patch = renewable_power_facility_patches
                .next()
                .expect("peeked renewable power facility patch disappeared");
            apply_renewable_power_facility_patch(&mut entities[entity_index], patch)?;
            continue;
        }
        if vein_settlement_outcomes
            .peek()
            .is_some_and(|outcome| outcome.entity_index < entity_index)
        {
            bail!("native vein settlement plan order diverged");
        }
        if vein_settlement_outcomes
            .peek()
            .is_some_and(|outcome| outcome.entity_index == entity_index)
        {
            let outcome = vein_settlement_outcomes
                .next()
                .expect("peeked native vein settlement outcome disappeared");
            let production = replay_vein_settlement(&mut entities[entity_index], outcome.result?)?;
            if let Some((item_id, produced)) = production {
                if let Some(events) = machine_production_events.as_mut() {
                    events.push(MachineProductionEvent::Inline { item_id, produced });
                } else {
                    add_produced_item(&mut produced_by_item, &item_id, produced);
                }
            }
            continue;
        }
        if local_machine_settlement_indices
            .as_mut()
            .and_then(|indices| indices.peek().copied())
            .is_some_and(|planned_index| planned_index < entity_index)
        {
            bail!("native local machine settlement plan order diverged");
        }
        if local_machine_settlement_indices
            .as_mut()
            .and_then(|indices| indices.peek().copied())
            == Some(entity_index)
        {
            // Capture every base-derived scalar at this exact row. Research
            // and Dyson machines remain serial below, so later local rows see
            // their post-barrier state even though private entity mutation is
            // deferred until the aggregate reaches the shared worker pool.
            let context = local_machine_settlement_context(state, base, entity_index)?;
            local_machine_settlement_indices
                .as_mut()
                .expect("parallel local machine index source disappeared")
                .next();
            let task_index = local_machine_settlement_tasks.len();
            local_machine_settlement_tasks.push(MachineLocalSettlementTask {
                entity_index,
                entity: std::mem::take(&mut entities[entity_index]),
                context,
                result: None,
            });
            machine_production_events
                .as_mut()
                .expect("parallel local machine production replay disappeared")
                .push(MachineProductionEvent::ParallelTask(task_index));
            continue;
        }
        let object = entity_object(&mut entities[entity_index])?;
        let kind = state
            .symbols
            .resolve(state.entities.kinds[entity_index])
            .unwrap_or_default();
        let planet = state.factory_topology.entity_planet_indices[entity_index];
        let grid = state.factory_topology.entity_grid_indices[entity_index];
        if planet == usize::MAX || grid == usize::MAX {
            bail!("native simple factory entity topology is unknown");
        }
        if kind == "power" {
            let building_id = state
                .symbols
                .resolve(state.entities.buildings[entity_index])
                .unwrap_or_default();
            let building = state
                .catalog
                .buildings
                .get(building_id)
                .ok_or_else(|| anyhow!("native simple factory power catalog is missing"))?;
            let machine_count = finite_number(object.get("machineCount"));
            let runtime = &grids[grid_slot(planet, grid)];
            let output = runtime
                .power_output_by_entity
                .get(&entity_index)
                .copied()
                .unwrap_or(0.0);
            let input = runtime
                .power_input_by_entity
                .get(&entity_index)
                .copied()
                .unwrap_or(0.0);
            let rated = building.power_generation_kw * machine_count;
            set_number(object, "powerOutputKw", rounded(output, 2))?;
            set_number(object, "powerInputKw", rounded(input, 2))?;
            set_number(
                object,
                "utilization",
                if rated > EPSILON {
                    rounded(output.max(input) / rated, 4)
                } else {
                    0.0
                },
            )?;
            set_number(object, "productionRate", 0.0)?;
            if is_fuel_generator(building_id) {
                burn_fuel(state, object, building, output, seconds)?;
            } else if building_id == "accumulator" {
                let capacity = energy_capacity(object, building);
                let next = (stored_energy(object, building) + input * seconds / 1_000.0
                    - output * seconds / 1_000.0)
                    .max(0.0)
                    .min(capacity);
                let rounded_next = rounded(next, 6);
                set_number(object, "storedEnergyMj", rounded_next)?;
                set_number(
                    object,
                    "progress",
                    if capacity > EPSILON {
                        rounded_next / capacity
                    } else {
                        0.0
                    },
                )?;
            } else if building_id == "energy_exchanger" {
                let completed = if string_at(object, "energyMode") == Some("discharge") {
                    discharge_exchanger(
                        state,
                        base,
                        object,
                        building,
                        output * seconds / 1_000.0,
                        production_buffer_limit,
                    )?
                } else {
                    charge_exchanger(
                        state,
                        base,
                        object,
                        building,
                        input * seconds / 1_000.0,
                        production_buffer_limit,
                    )?
                };
                set_number(
                    object,
                    "productionRate",
                    if seconds > EPSILON {
                        rounded(completed * 60.0 / seconds, 2)
                    } else {
                        0.0
                    },
                )?;
            }
            continue;
        }
        if kind == "machine" {
            let building_id = state
                .symbols
                .resolve(state.entities.buildings[entity_index])
                .unwrap_or_default();
            if matches!(
                building_id,
                "construction_center"
                    | "time_warp_device"
                    | "ray_receiver"
                    | "galactic_material_exporter"
                    | "micro_black_hole_connector"
            ) {
                continue;
            }
            let recipe_id = state
                .symbols
                .resolve(state.entities.recipes[entity_index])
                .unwrap_or_default();
            let building = state
                .catalog
                .buildings
                .get(building_id)
                .ok_or_else(|| anyhow!("native simple factory machine building is missing"))?;
            let recipe = state
                .catalog
                .recipes
                .get(recipe_id)
                .ok_or_else(|| anyhow!("native simple factory machine recipe is missing"))?;
            if let Some(factor) = power_factors.get(&entity_index).copied() {
                set_number(object, "powerFactor", rounded(factor, 4))?;
            } else {
                object.remove("powerFactor");
            }
            if !recipe_technology_available(base, recipe) {
                set_number(object, "progress", 0.0)?;
                set_number(object, "utilization", 0.0)?;
                set_number(object, "productionRate", 0.0)?;
                continue;
            }
            let machine_count = finite_number(object.get("machineCount"));
            let capacity = stacked_capacity(
                building.output_capacity,
                machine_count,
                production_buffer_limit,
            );
            let input_cycles =
                (machine_input_cycles(state, base, object, recipe) + EPSILON).floor();
            let output_cycles = (machine_output_cycles(
                state,
                object,
                recipe,
                capacity,
                input_cycles,
                Some(&belt_reservation.output_credits),
            ) + EPSILON)
                .floor();
            let maximum_cycles = input_cycles.min(output_cycles);
            let sprayed_cycle_limit = available_full_proliferator_cycles(state, object, recipe);
            let extra_product_bonus = proliferator_extra_bonus(state, object, recipe);
            let progress_at_start = finite_number(object.get("progress"));
            let power_factor = power_factors.get(&entity_index).copied().unwrap_or(1.0);
            let planet_speed = if specialization_applies(profiles[planet], building) {
                profiles[planet].production_speed_multiplier
            } else {
                1.0
            };
            let recipe_speed = if recipe.id == "matrix_research" {
                research_speed_multiplier(base)
            } else {
                industrial_speed_multiplier(base)
            };
            let effective_cycles_per_second =
                building.speed * machine_count * recipe_speed * planet_speed / recipe.duration;
            let launch_factor = crate::dyson::launch_factor(base, &recipe.id);
            let base_rate = effective_cycles_per_second * power_factor * launch_factor;
            let mut potential_cycles = base_rate * seconds;
            let mut sprayed_work = 0.0;
            if string_at(object, "proliferatorMode") == Some("speed")
                && sprayed_cycle_limit > 0.0
                && base_rate > EPSILON
            {
                let accelerated_rate =
                    base_rate * proliferator_speed_multiplier(state, object, recipe);
                let accelerated_capacity =
                    (maximum_cycles.min(sprayed_cycle_limit) - progress_at_start).max(0.0);
                let accelerated_seconds =
                    seconds.min(accelerated_capacity / accelerated_rate.max(EPSILON));
                sprayed_work = accelerated_capacity.min(accelerated_rate * accelerated_seconds);
                potential_cycles =
                    sprayed_work + base_rate * (seconds - accelerated_seconds).max(0.0);
            }
            if maximum_cycles < 1.0 || potential_cycles <= EPSILON {
                set_number(object, "utilization", 0.0)?;
                set_number(object, "productionRate", 0.0)?;
                continue;
            }
            let work = potential_cycles.min((maximum_cycles - progress_at_start).max(0.0));
            if string_at(object, "proliferatorMode") != Some("speed") {
                sprayed_work = work.min((sprayed_cycle_limit - progress_at_start).max(0.0));
            }
            let progressed = rounded(progress_at_start + work, 6);
            let cycles = maximum_cycles.min((progressed + EPSILON).floor());
            let sprayed_cycles = cycles.min(sprayed_cycle_limit);
            if recipe.id == "matrix_research" {
                let (consumed, completed) = if selected_technology_id(base).is_some() {
                    invest_finite_research(
                        state,
                        base,
                        object,
                        cycles,
                        has_galactic_material_exporter,
                    )?
                } else {
                    invest_infinite_research(base, object, cycles)?
                };
                consume_proliferator_points(state, object, recipe, sprayed_cycles.min(consumed))?;
                reset_research_progress_before_next_entity |= completed;
            } else {
                let inputs = object
                    .get_mut("inputs")
                    .and_then(Value::as_object_mut)
                    .ok_or_else(|| anyhow!("native simple factory machine inputs are missing"))?;
                for input in &recipe.inputs {
                    let current = finite_number(inputs.get(&input.item_id));
                    set_machine_item_number(
                        inputs,
                        &input.item_id,
                        (current - input.amount * cycles).max(0.0).floor(),
                    );
                }
                consume_proliferator_points(state, object, recipe, sprayed_cycles)?;
                crate::dyson::launch_deferred(
                    &mut dyson_launch_runtime,
                    state,
                    base,
                    object,
                    &recipe.id,
                    cycles,
                )?;
                for output in &recipe.outputs {
                    let accumulated_bonus = object
                        .get("proliferatorBonusProgress")
                        .and_then(Value::as_object)
                        .and_then(|values| values.get(&output.item_id))
                        .map(|value| finite_number(Some(value)))
                        .unwrap_or(0.0)
                        + output.amount * sprayed_cycles * extra_product_bonus;
                    let bonus_produced = (accumulated_bonus + EPSILON).floor();
                    let produced = output.amount * cycles + bonus_produced;
                    let current = object
                        .get("outputs")
                        .and_then(Value::as_object)
                        .and_then(|outputs| outputs.get(&output.item_id))
                        .map(|value| finite_number(Some(value)))
                        .unwrap_or(0.0);
                    let outputs = object
                        .get_mut("outputs")
                        .and_then(Value::as_object_mut)
                        .ok_or_else(|| {
                            anyhow!("native simple factory machine outputs are missing")
                        })?;
                    set_machine_item_number(outputs, &output.item_id, (current + produced).floor());
                    let bonus_progress = object
                        .get_mut("proliferatorBonusProgress")
                        .and_then(Value::as_object_mut)
                        .ok_or_else(|| anyhow!("native simple factory bonus record is missing"))?;
                    set_machine_item_number(
                        bonus_progress,
                        &output.item_id,
                        (accumulated_bonus - bonus_produced).max(0.0),
                    );
                    if let Some(events) = machine_production_events.as_mut() {
                        events.push(MachineProductionEvent::Inline {
                            item_id: output.item_id.clone(),
                            produced,
                        });
                    } else {
                        add_produced_item(&mut produced_by_item, &output.item_id, produced);
                    }
                }
            }
            set_number(
                object,
                "progress",
                rounded((progressed - cycles).max(0.0), 6),
            )?;
            let activity_factor = if potential_cycles > EPSILON {
                (work / potential_cycles).min(1.0)
            } else {
                0.0
            };
            set_number(
                object,
                "utilization",
                rounded(power_factor * launch_factor * activity_factor, 4),
            )?;
            let base_units_per_cycle = if matches!(
                recipe.id.as_str(),
                "matrix_research" | "solar_sail_launch" | "carrier_rocket_launch"
            ) {
                1.0
            } else {
                recipe
                    .outputs
                    .iter()
                    .map(|output| output.amount)
                    .sum::<f64>()
            };
            let bonus_units_per_cycle = if work > EPSILON {
                base_units_per_cycle * extra_product_bonus * sprayed_work / work
            } else {
                0.0
            };
            set_number(
                object,
                "productionRate",
                rounded(
                    work / seconds * (base_units_per_cycle + bonus_units_per_cycle) * 60.0,
                    2,
                ),
            )?;
            continue;
        }
        if matches!(kind, "storage" | "splitter") {
            continue;
        }
    }
    if vein_settlement_outcomes.next().is_some() {
        bail!("native vein settlement plan was not fully replayed");
    }
    if renewable_power_facility_patches.next().is_some() {
        bail!("native renewable power facility patches were not fully applied");
    }
    if local_machine_settlement_indices
        .as_mut()
        .is_some_and(|indices| indices.next().is_some())
    {
        bail!("native local machine settlement plan was not fully applied");
    }
    if let Some(events) = machine_production_events {
        let outcomes = execute_local_machine_settlement_tasks_with_runtime(
            runtime,
            state,
            entities,
            &mut local_machine_settlement_tasks,
            &profiles,
            &power_factors,
            &belt_reservation.output_credits,
            production_buffer_limit,
            seconds,
        );
        let mut outcomes = outcomes.into_iter().map(Some).collect::<Vec<_>>();
        // Replay placeholders and serial contributions in their original row
        // and output order. In particular, do not reduce worker-local f64
        // totals: IEEE-754 addition order is observable in totalProduced.
        for event in events {
            match event {
                MachineProductionEvent::ParallelTask(task_index) => {
                    let outcome = outcomes
                        .get_mut(task_index)
                        .and_then(Option::take)
                        .ok_or_else(|| {
                            anyhow!("native local machine production replay diverged")
                        })?;
                    merge_local_machine_production(state, outcome, &mut produced_by_item)?;
                }
                MachineProductionEvent::Inline { item_id, produced } => {
                    add_produced_item(&mut produced_by_item, &item_id, produced);
                }
            }
        }
        if outcomes.iter().any(Option::is_some) {
            bail!("native local machine settlement outcome was not replayed");
        }
    }
    crate::dyson::commit_deferred_launches(base, dyson_launch_runtime);
    let mut next_machine_awake = Vec::with_capacity(
        ordinary_production_selection
            .selected_supported_machine_indices
            .len(),
    );
    for &entity_index in &ordinary_production_selection.selected_supported_machine_indices {
        let object = entities[entity_index]
            .as_object()
            .ok_or_else(|| anyhow!("native simple factory entity is not an object"))?;
        let building = string_at(object, "buildingId")
            .and_then(|id| state.catalog.buildings.get(id))
            .ok_or_else(|| anyhow!("native simple factory machine building is missing"))?;
        let recipe = string_at(object, "recipeId")
            .and_then(|id| state.catalog.recipes.get(id))
            .ok_or_else(|| anyhow!("native simple factory machine recipe is missing"))?;
        next_machine_awake.push((
            entity_index,
            pre_step_active_machine_indices
                .binary_search(&entity_index)
                .is_ok()
                || machine_can_run(
                    state,
                    base,
                    object,
                    building,
                    recipe,
                    production_buffer_limit,
                ),
        ));
    }
    let mut next_vein_awake = Vec::with_capacity(
        ordinary_production_selection
            .selected_supported_vein_indices
            .len(),
    );
    for &entity_index in &ordinary_production_selection.selected_supported_vein_indices {
        let awake = pre_step_active_vein_indices
            .binary_search(&entity_index)
            .is_ok()
            || probe_vein_demand(
                state,
                entities,
                production_buffer_limit,
                power_demand_multiplier,
                entity_index,
            )?
            .is_some_and(|probe| probe.demand_active);
        next_vein_awake.push((entity_index, awake));
    }
    let ordinary_production_scan = production_step_runtime.commit_selection(
        ordinary_production_selection,
        &next_machine_awake,
        &next_vein_awake,
    )?;
    execution_diagnostics.observe(
        FactoryScanStage::OrdinaryProduction,
        ordinary_production_scan.selected_rows,
        ordinary_production_scan.total_rows,
        ordinary_production_scan.stable_rows_skipped,
        ordinary_production_scan.dense_fallback,
        ordinary_production_scan.directory_fallback,
        ordinary_production_scan.full_scan,
    );
    planet_metric_directory_fallback |= ordinary_production_scan.directory_fallback;
    if profile_enabled {
        eprintln!(
            "DSP_NATIVE_CORE_PROFILE\tordinary-production-active\t{}/{}\tskipped={}\tdense={}\tdirectory-fallback={}\tresearch-boundary={}",
            ordinary_production_scan.selected_rows,
            ordinary_production_scan.total_rows,
            ordinary_production_scan.stable_rows_skipped,
            ordinary_production_scan.dense_fallback,
            ordinary_production_scan.directory_fallback,
            research_boundary.profile_label(),
        );
    }
    profile_mark!("power-facilities-machines-miners");

    if reset_research_progress_before_next_entity {
        reset_indexed_research_machine_progress(entities, research_entity_indexes)?;
    }
    profile_mark!("research-reset");

    if !isolate_construction_automation {
        let construction_outcome = crate::construction::run_centers(
            state,
            base,
            entities,
            seconds,
            &power_factors,
            &state.factory_topology.construction_center_indices,
            std::sync::Arc::make_mut(construction_runtime),
        )?;
        execution_diagnostics.observe(
            FactoryScanStage::Construction,
            construction_outcome.scan.selected_rows,
            construction_outcome.scan.total_rows,
            construction_outcome
                .scan
                .total_rows
                .saturating_sub(construction_outcome.scan.selected_rows),
            construction_outcome.scan.dense_fallback,
            construction_outcome.scan.directory_fallback,
            construction_outcome.scan.dense_fallback
                || construction_outcome.scan.directory_fallback,
        );
        quantum_step_runtime
            .wake_construction_centers(&construction_outcome.quantum_wake.center_indices);
        writer_events.record_rows(
            FactoryWriterDomain::Construction,
            &construction_outcome.planet_metric_writer_indices,
        )?;
        planet_metric_directory_fallback |= construction_outcome.scan.directory_fallback;
        if profile_enabled {
            eprintln!(
                "DSP_NATIVE_CORE_PROFILE\tconstruction-active\t{}/{}\tdense={}\tdirectory-fallback={}",
                construction_outcome.scan.selected_rows,
                construction_outcome.scan.total_rows,
                construction_outcome.scan.dense_fallback,
                construction_outcome.scan.directory_fallback,
            );
        }
    }
    profile_mark!("construction");

    crate::dyson::run_ray_receivers(
        state,
        base,
        entities,
        seconds,
        &belt_reservation.output_credits,
        &reception,
    )?;
    writer_events.record_rows(FactoryWriterDomain::Dyson, &reception.receiver_indices)?;
    profile_mark!("ray-receivers");

    crate::orbital_station::settle(state, base, entities, seconds)?;
    writer_events.record_rows(
        FactoryWriterDomain::Logistics,
        &state.factory_topology.orbital_cargo_terminal_indices,
    )?;
    profile_mark!("orbital-cargo-terminals");

    if !produced_by_item.is_empty() {
        let total = base
            .get_mut("totalProduced")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native simple factory total production record is missing"))?;
        for (item, produced) in produced_by_item {
            let previous = finite_number(total.get(&item));
            total.insert(
                item,
                Number::from_f64((previous + produced).floor())
                    .map(Value::Number)
                    .unwrap_or(Value::from(0)),
            );
        }
    }

    let planet_metric_writer_indices = writer_events.all_rows();
    {
        let metric_runtime = std::sync::Arc::make_mut(planet_metrics_runtime);
        if planet_metric_directory_fallback {
            metric_runtime.force_directory_fallback();
        } else {
            metric_runtime.wake_entity_indices(&planet_metric_writer_indices);
        }
    }
    // Entity probes use the writer-closed wake snapshot. The compact results
    // still replay in historical global row order for exact IEEE-754 bytes.
    let (total_items_before_global, power_reserves_by_planet) =
        collect_planet_metrics_with_runtime(
            runtime,
            state,
            entities,
            planet_ids.len(),
            planet_metrics_runtime,
            planet_metric_mode,
        )?;
    let planet_metric_scan = planet_metrics_runtime.last_scan();
    execution_diagnostics.observe(
        FactoryScanStage::PlanetMetrics,
        planet_metric_scan.selected_rows,
        planet_metric_scan.total_rows,
        planet_metric_scan.stable_rows_skipped,
        planet_metric_scan.dense_fallback,
        planet_metric_scan.directory_fallback,
        planet_metric_scan.full_scan,
    );
    #[cfg(test)]
    if planet_metric_mode == PlanetMetricProbeMode::IndexedFailAfterCollect {
        bail!("injected failure after planet metric candidate collection");
    }
    profile_mark!("planet-metrics-probe");

    let quantum_flow = if crossed_quantum_boundary {
        let (flow, scan) = crate::quantum_logistics::settle_active_downloads(
            state,
            base,
            entities,
            &belt_reservation.output_credits,
            first_quantum_boundary as f64 * 5.0,
            5.0,
            quantum_step_runtime,
            &step_route_ledger,
        )?;
        execution_diagnostics.observe(
            FactoryScanStage::Quantum,
            scan.selected_rows,
            scan.total_rows,
            scan.total_rows.saturating_sub(scan.selected_rows),
            scan.dense_fallback,
            scan.directory_fallback,
            scan.dense_fallback || scan.directory_fallback,
        );
        crate::quantum_logistics::record_quantum_oactive_scan(
            crate::quantum_logistics::QuantumOactiveProfileStage::Download,
            scan,
        );
        if profile_enabled {
            eprintln!(
                "DSP_NATIVE_CORE_PROFILE\tquantum-download-active\t{}/{}\tdense={}\tdirectory-fallback={}",
                scan.selected_rows, scan.total_rows, scan.dense_fallback, scan.directory_fallback,
            );
        }
        if scan.directory_fallback {
            std::sync::Arc::make_mut(planet_metrics_runtime).force_directory_fallback();
        }
        let construction_inventory_wakes =
            quantum_step_runtime.take_construction_inventory_written_center_indices();
        let construction_step_runtime = std::sync::Arc::make_mut(construction_runtime);
        if scan.directory_fallback {
            // The permissive quantum oracle does not retain an indexed
            // delivery trace. Its rare fallback therefore wakes every center
            // rather than guessing which direct buffer changed.
            construction_step_runtime.wake_all();
        } else {
            construction_step_runtime.wake_center_indices(&construction_inventory_wakes);
        }
        flow
    } else {
        None
    };
    let mut late_logistics_changed_entity_indices = Vec::new();
    if quantum_boundary_changed_station_inventory(quantum_flow.as_ref())
        && let Some(flow) = quantum_flow.as_ref()
    {
        quantum_step_runtime.wake_flush_from_downloads(flow);
    }
    let quantum_download_changed_station_indices =
        quantum_step_runtime.take_inventory_written_station_indices();
    writer_events.record_rows(
        FactoryWriterDomain::Quantum,
        &quantum_download_changed_station_indices,
    )?;
    std::sync::Arc::make_mut(planet_metrics_runtime)
        .wake_entity_indices(&quantum_download_changed_station_indices);
    crate::interstellar_logistics::wake_warper_refill_from_changed_stations(
        &quantum_download_changed_station_indices,
        std::sync::Arc::make_mut(interstellar_route_activity),
    );
    late_logistics_changed_entity_indices.extend(quantum_download_changed_station_indices);
    profile_mark!("quantum-download");

    // Research can finish between the input and output logistics barriers.
    // Re-read the live level through the O(1) directory cache so an immediate
    // upload created after that boundary uses JavaScript's current multiplier.
    let post_research_quantum_runtime_bandwidth =
        quantum_step_runtime.legacy_runtime_bandwidth(state, base, entities);
    crate::belts::transfer_with_bandwidth(
        state,
        base,
        entities,
        belt_runtime,
        belt_routes,
        post_research_quantum_runtime_bandwidth,
        0.0,
        false,
        Some(&belt_reservation),
        seconds,
        &mut belt_changed_entity_indices,
    )?;
    writer_events.record_rows(FactoryWriterDomain::Belt, &belt_changed_entity_indices)?;
    std::sync::Arc::make_mut(planet_metrics_runtime)
        .wake_entity_indices(&belt_changed_entity_indices);
    // `belts::transfer` clears and repopulates its movement evidence for each
    // phase. At this point the vector is therefore exactly the late output
    // transfer set, not an append-only continuation of the input phase.
    crate::belts::wake_tracked_station_sources(
        state,
        entities,
        belt_runtime,
        belt_routes,
        &belt_changed_entity_indices,
    )?;
    late_logistics_changed_entity_indices.extend_from_slice(&belt_changed_entity_indices);
    crate::local_logistics::wake_transfer_buffers_from_changed_entities(
        entities,
        &belt_changed_entity_indices,
        local_step_runtime,
    )?;
    std::sync::Arc::make_mut(logistics_buffer_runtime)
        .wake_from_changed_entities(state, &belt_changed_entity_indices);
    std::sync::Arc::make_mut(material_delivery_runtime)
        .wake_from_changed_entities(state, &belt_changed_entity_indices);
    production_step_runtime.wake_from_changed_entities(&belt_changed_entity_indices);
    local_step_runtime.wake_ready_from_changed_stations(&late_logistics_changed_entity_indices);
    crate::interstellar_logistics::wake_dispatch_from_changed_stations(
        &late_logistics_changed_entity_indices,
        interstellar_peer_directory,
        std::sync::Arc::make_mut(interstellar_route_activity),
    );
    crate::interstellar_logistics::wake_warper_refill_from_changed_stations(
        &belt_changed_entity_indices,
        std::sync::Arc::make_mut(interstellar_route_activity),
    );
    quantum_step_runtime.wake_from_stations(&belt_changed_entity_indices);
    let material_delivery_outcome = drain_material_delivery_hubs(
        state,
        base,
        entities,
        std::sync::Arc::make_mut(material_delivery_runtime),
        seconds,
        true,
        material_delivery_mode,
    )?;
    execution_diagnostics.observe(
        FactoryScanStage::MaterialDelivery,
        material_delivery_outcome.scan.selected_rows,
        material_delivery_outcome.scan.total_rows,
        material_delivery_outcome.scan.stable_rows_skipped,
        material_delivery_outcome.scan.dense_fallback,
        material_delivery_outcome.scan.directory_fallback,
        material_delivery_outcome.scan.full_scan,
    );
    writer_events.record_rows(
        FactoryWriterDomain::Inventory,
        &material_delivery_outcome.written_entity_indices,
    )?;
    {
        let metric_runtime = std::sync::Arc::make_mut(planet_metrics_runtime);
        metric_runtime.wake_entity_indices(&material_delivery_outcome.written_entity_indices);
        if material_delivery_outcome.scan.directory_fallback {
            metric_runtime.force_directory_fallback();
        }
    }
    if profile_enabled {
        eprintln!(
            "DSP_NATIVE_CORE_PROFILE\tmaterial-delivery-active-post\t{}/{}\tskipped={}\tdense={}\tdirectory-fallback={}",
            material_delivery_outcome.scan.selected_rows,
            material_delivery_outcome.scan.total_rows,
            material_delivery_outcome.scan.stable_rows_skipped,
            material_delivery_outcome.scan.dense_fallback,
            material_delivery_outcome.scan.directory_fallback,
        );
    }
    profile_mark!("belt-output-transfer");

    crate::interstellar_logistics::refresh_peer_directory(
        state,
        base,
        entities,
        false,
        interstellar_peer_directory,
        interstellar_route_activity,
    );
    crate::interstellar_logistics::refresh_warper_tray_wakes(
        base,
        std::sync::Arc::make_mut(interstellar_route_activity),
    );
    let (station_power_indices, station_power_scan) =
        crate::interstellar_logistics::select_station_power_indices(
            &state.factory_topology.station_indices,
            &ready_logistics_station_indices,
            &late_logistics_changed_entity_indices,
            local_step_runtime,
            interstellar_peer_directory,
            interstellar_route_activity,
        );
    let station_powers = station_power_indices
        .iter()
        .copied()
        .filter_map(|entity_index| {
            let object = entities[entity_index].as_object()?;
            if string_at(object, "buildingId") == Some("orbital_collector") {
                return Some((entity_index, 1.0));
            }
            let planet = state.factory_topology.entity_planet_indices[entity_index];
            let grid = state.factory_topology.entity_grid_indices[entity_index];
            if planet == usize::MAX || grid == usize::MAX {
                return None;
            }
            Some((
                entity_index,
                power_factors
                    .get(&entity_index)
                    .copied()
                    .unwrap_or(grids[grid_slot(planet, grid)].factor),
            ))
        })
        .collect::<HashMap<_, _>>();
    if profile_enabled {
        eprintln!(
            "DSP_NATIVE_CORE_PROFILE\tstation-power-active\t{}/{}\tdense={}\tdirectory-fallback={}\truntime-fallback={}",
            station_power_scan.selected_station_rows,
            station_power_scan.total_station_rows,
            station_power_scan.dense_fallback,
            station_power_scan.directory_fallback,
            station_power_scan.runtime_fallback,
        );
    }
    if station_power_scan.directory_fallback || station_power_scan.runtime_fallback {
        std::sync::Arc::make_mut(planet_metrics_runtime).force_directory_fallback();
    }
    crate::interstellar_logistics::refresh_dispatch_power_wakes(
        &station_power_indices,
        &station_powers,
        interstellar_peer_directory,
        std::sync::Arc::make_mut(interstellar_route_activity),
    );
    let (warper_changed_station_indices, warper_refill_scan) =
        crate::interstellar_logistics::refill_station_warpers(
            base,
            entities,
            std::sync::Arc::make_mut(interstellar_route_activity),
            &step_route_ledger,
        )?;
    execution_diagnostics.observe(
        FactoryScanStage::WarperRefill,
        warper_refill_scan.selected_station_rows,
        warper_refill_scan.total_station_rows,
        warper_refill_scan
            .total_station_rows
            .saturating_sub(warper_refill_scan.selected_station_rows),
        warper_refill_scan.dense_fallback,
        warper_refill_scan.directory_fallback,
        warper_refill_scan.dense_fallback || warper_refill_scan.directory_fallback,
    );
    writer_events.record_rows(
        FactoryWriterDomain::Logistics,
        &warper_changed_station_indices,
    )?;
    std::sync::Arc::make_mut(planet_metrics_runtime)
        .wake_entity_indices(&warper_changed_station_indices);
    if warper_refill_scan.directory_fallback {
        std::sync::Arc::make_mut(planet_metrics_runtime).force_directory_fallback();
    }
    if profile_enabled {
        eprintln!(
            "DSP_NATIVE_CORE_PROFILE\twarper-refill-active\t{}/{}\treservation-rows={}\tdense={}\tdirectory-fallback={}",
            warper_refill_scan.selected_station_rows,
            warper_refill_scan.total_station_rows,
            warper_refill_scan.reservation_rows_visited,
            warper_refill_scan.dense_fallback,
            warper_refill_scan.directory_fallback,
        );
    }
    crate::interstellar_logistics::wake_dispatch_from_changed_stations(
        &warper_changed_station_indices,
        interstellar_peer_directory,
        std::sync::Arc::make_mut(interstellar_route_activity),
    );
    local_step_runtime.wake_ready_from_changed_stations(&warper_changed_station_indices);
    crate::belts::wake_tracked_station_sources(
        state,
        entities,
        belt_runtime,
        belt_routes,
        &warper_changed_station_indices,
    )?;
    if profile_enabled {
        let scan = step_route_ledger.scan();
        eprintln!(
            "DSP_NATIVE_CORE_PROFILE\tstation-route-ledger-dispatch-reuse\t{}/{}\tdense={}",
            scan.selected_demands, scan.total_candidate_rows, scan.dense_fallback
        );
    }
    profile_mark!("local-dispatch-preparation");
    let profile_operation = profile_enabled
        .then(crate::profile_evidence::current_profile_operation_binding)
        .flatten();
    let timing_profile = profile_operation.as_ref().is_some_and(|binding| {
        binding.purpose() == crate::profile_evidence::ProfileOperationPurpose::LocalDispatchTimingV1
    });
    let shape_profile = profile_operation.as_ref().is_some_and(|binding| {
        binding.purpose() == crate::profile_evidence::ProfileOperationPurpose::LocalDispatchShapeV1
    });
    let local_dispatch_started = timing_profile.then(std::time::Instant::now);
    let local_dispatch_scan = if shape_profile {
        crate::local_logistics::dispatch_profiled(
            state,
            base,
            entities,
            &station_powers,
            local_step_runtime,
            &mut step_route_ledger,
        )?
    } else {
        crate::local_logistics::dispatch(
            state,
            base,
            entities,
            &station_powers,
            local_step_runtime,
            &mut step_route_ledger,
        )?
    };
    execution_diagnostics.observe(
        FactoryScanStage::LocalDispatch,
        local_dispatch_scan.selected_station_rows,
        local_dispatch_scan.total_station_rows,
        local_dispatch_scan
            .total_station_rows
            .saturating_sub(local_dispatch_scan.selected_station_rows),
        local_dispatch_scan.dense_fallback,
        local_dispatch_scan.directory_fallback,
        local_dispatch_scan.dense_fallback || local_dispatch_scan.directory_fallback,
    );
    let local_dispatch_duration_ns = local_dispatch_started
        .map(|started| u64::try_from(started.elapsed().as_nanos()).unwrap_or(u64::MAX))
        .unwrap_or(0);
    if local_dispatch_scan.directory_fallback {
        std::sync::Arc::make_mut(planet_metrics_runtime).force_directory_fallback();
    }
    profile_mark!("local-dispatch");
    if profile_enabled {
        eprintln!(
            "DSP_NATIVE_CORE_PROFILE\tlocal-dispatch-active\t{}/{}\tdemands={}/{}\tdense={}\tdirectory-fallback={}",
            local_dispatch_scan.selected_station_rows,
            local_dispatch_scan.total_station_rows,
            local_dispatch_scan.selected_demand_rows,
            local_dispatch_scan.total_demand_rows,
            local_dispatch_scan.dense_fallback,
            local_dispatch_scan.directory_fallback,
        );
        if let Some(binding) = profile_operation
            .as_ref()
            .filter(|_| timing_profile || shape_profile)
        {
            let operation_binding = json!({
                "protocol": "native-core-advance-profile-v1",
                "requestId": binding.request_id(),
                "sessionIdSha256": hex::encode(binding.session_id_sha256()),
                "baseRevision": binding.base_revision(),
                "expectedMeasuredRevision": binding.expected_measured_revision(),
                "profilePurpose": binding.purpose().as_str(),
            });
            let structured_profile = if timing_profile {
                json!({
                    "schemaVersion": 2,
                    "recordType": "local-dispatch-timing",
                    "instrumentationVersion": "local-dispatch-profile-v3",
                    "measurementScope": "production-dispatch-only-observer-excluded",
                    "stageDurationNs": local_dispatch_duration_ns,
                    "operationBinding": operation_binding,
                })
            } else {
                let profile = local_dispatch_scan
                    .profile
                    .expect("shape-only local dispatch profile");
                json!({
                    "schemaVersion": 2,
                    "recordType": "local-dispatch-planet-shards",
                    "instrumentationVersion": "local-dispatch-profile-v3",
                    "workScope": "shape-proxy-only-not-time-or-speedup",
                    "productGate": "full-advance-stage-share-times-parallelizable-share-at-least-3.5-percent",
                    "selectedDemands": profile.selected_demands,
                    "totalDemands": profile.total_demands,
                    "planetShards": profile.planet_shards,
                    "demandSlots": profile.demand_slots,
                    "peerEdges": profile.peer_edges,
                    "sortWorkUnits": profile.sort_work_units,
                    "totalWorkUnits": profile.total_work_units,
                    "largestShardWorkUnits": profile.largest_shard_work_units,
                    "largestShardRatioPpm": profile.largest_shard_ratio_ppm,
                    "parallelizableWorkUnits": profile.parallelizable_work_units,
                    "parallelizableRatioPpm": profile.parallelizable_ratio_ppm,
                    "routeEvents": profile.route_events,
                    "shardWorkSha256": hex::encode(profile.shard_work_sha256),
                    "planetIdentityProven": profile.planet_identity_proven,
                    "scanFallback": profile.scan_fallback.as_str(),
                    "parallelFallback": profile.parallel_fallback.as_str(),
                    "operationBinding": operation_binding,
                })
            };
            let captured = crate::profile_evidence::record_profile_operation_evidence(
                structured_profile.clone(),
            );
            eprintln!(
                "DSP_NATIVE_CORE_PROFILE_RECORD_DIAGNOSTIC\t{}\tcaptured={captured}",
                structured_profile,
            );
        }
    }
    let interstellar_step_runtime = std::sync::Arc::make_mut(interstellar_route_activity);
    let interstellar_dispatch_scan = crate::interstellar_logistics::dispatch(
        state,
        base,
        entities,
        &station_powers,
        interstellar_step_runtime,
        interstellar_peer_directory,
        &mut step_route_ledger,
    )?;
    execution_diagnostics.observe(
        FactoryScanStage::InterstellarDispatch,
        interstellar_dispatch_scan.selected_demands,
        interstellar_dispatch_scan.total_demand_rows,
        interstellar_dispatch_scan
            .total_demand_rows
            .saturating_sub(interstellar_dispatch_scan.selected_demands),
        interstellar_dispatch_scan.dense_fallback,
        interstellar_dispatch_scan.directory_fallback,
        interstellar_dispatch_scan.dense_fallback || interstellar_dispatch_scan.directory_fallback,
    );
    if interstellar_dispatch_scan.directory_fallback {
        std::sync::Arc::make_mut(planet_metrics_runtime).force_directory_fallback();
    }
    if profile_enabled {
        eprintln!(
            "DSP_NATIVE_CORE_PROFILE\tinterstellar-dispatch-active\t{}/{}\tprobed={}\tdense={}\tpeer-candidates={}\tfull-scan-rows={}\tdirectory-fallback={}",
            interstellar_dispatch_scan.selected_demands,
            interstellar_dispatch_scan.total_demand_rows,
            interstellar_dispatch_scan.demand_rows_probed,
            interstellar_dispatch_scan.dense_fallback,
            interstellar_dispatch_scan.peer_candidate_rows_visited,
            interstellar_dispatch_scan.peer_full_scan_rows_visited,
            interstellar_dispatch_scan.directory_fallback,
        );
    }
    let dispatch_route_station_indices = step_route_ledger.active_station_indices();
    quantum_step_runtime.wake_from_stations(&dispatch_route_station_indices);
    drop(step_route_ledger);
    profile_mark!("interstellar-dispatch");
    let local_route_changed_station_indices =
        crate::local_logistics::advance_routes_with_bandwidth(
            state,
            base,
            entities,
            post_research_quantum_runtime_bandwidth,
            seconds,
            &station_powers,
            local_step_runtime,
        )?;
    writer_events.record_rows(
        FactoryWriterDomain::Route,
        &local_route_changed_station_indices,
    )?;
    std::sync::Arc::make_mut(planet_metrics_runtime)
        .wake_entity_indices(&local_route_changed_station_indices);
    profile_mark!("local-route-advance");
    let remote_route_changed_station_indices = crate::interstellar_logistics::advance_routes(
        state,
        entities,
        seconds,
        &station_powers,
        interstellar_step_runtime,
    )?;
    writer_events.record_rows(
        FactoryWriterDomain::Route,
        &remote_route_changed_station_indices,
    )?;
    std::sync::Arc::make_mut(planet_metrics_runtime)
        .wake_entity_indices(&remote_route_changed_station_indices);
    // `stationTrips` is the only Campaign factory metric written by an exact
    // simulation step. Both route domains return their writer-closed active
    // station rows, including source/target owners and deterministic peers.
    crate::interstellar_logistics::wake_dispatch_from_changed_stations(
        &local_route_changed_station_indices,
        interstellar_peer_directory,
        interstellar_step_runtime,
    );
    crate::interstellar_logistics::wake_warper_refill_from_changed_stations(
        &local_route_changed_station_indices,
        interstellar_step_runtime,
    );
    crate::interstellar_logistics::wake_dispatch_from_changed_stations(
        &remote_route_changed_station_indices,
        interstellar_peer_directory,
        interstellar_step_runtime,
    );
    crate::interstellar_logistics::wake_warper_refill_from_changed_stations(
        &remote_route_changed_station_indices,
        interstellar_step_runtime,
    );
    local_step_runtime.wake_ready_from_changed_stations(&local_route_changed_station_indices);
    local_step_runtime.wake_ready_from_changed_stations(&remote_route_changed_station_indices);
    quantum_step_runtime.wake_from_stations(&local_route_changed_station_indices);
    quantum_step_runtime.wake_from_stations(&remote_route_changed_station_indices);
    crate::belts::wake_tracked_station_sources(
        state,
        entities,
        belt_runtime,
        belt_routes,
        &local_route_changed_station_indices,
    )?;
    crate::belts::wake_tracked_station_sources(
        state,
        entities,
        belt_runtime,
        belt_routes,
        &remote_route_changed_station_indices,
    )?;
    profile_mark!("interstellar-route-advance");
    // Route advance can complete the final flight and release an output
    // reservation. Rebuild the already-required congestion ledger once here
    // so post-route warper refill reads the exact post-advance reservation
    // set without rescanning every entity a second time.
    let congestion_route_ledger = crate::station_route_ledger::StationRouteLedger::build(
        state,
        entities,
        local_step_runtime,
        interstellar_step_runtime,
    );
    let (post_route_warper_changed_station_indices, post_route_warper_refill_scan) =
        crate::interstellar_logistics::refill_station_warpers(
            base,
            entities,
            interstellar_step_runtime,
            &congestion_route_ledger,
        )?;
    execution_diagnostics.observe(
        FactoryScanStage::WarperRefill,
        post_route_warper_refill_scan.selected_station_rows,
        post_route_warper_refill_scan.total_station_rows,
        post_route_warper_refill_scan
            .total_station_rows
            .saturating_sub(post_route_warper_refill_scan.selected_station_rows),
        post_route_warper_refill_scan.dense_fallback,
        post_route_warper_refill_scan.directory_fallback,
        post_route_warper_refill_scan.dense_fallback
            || post_route_warper_refill_scan.directory_fallback,
    );
    writer_events.record_rows(
        FactoryWriterDomain::Logistics,
        &post_route_warper_changed_station_indices,
    )?;
    std::sync::Arc::make_mut(planet_metrics_runtime)
        .wake_entity_indices(&post_route_warper_changed_station_indices);
    if post_route_warper_refill_scan.directory_fallback {
        std::sync::Arc::make_mut(planet_metrics_runtime).force_directory_fallback();
    }
    if profile_enabled {
        eprintln!(
            "DSP_NATIVE_CORE_PROFILE\twarper-refill-post-route-active\t{}/{}\treservation-rows={}\tdense={}\tdirectory-fallback={}",
            post_route_warper_refill_scan.selected_station_rows,
            post_route_warper_refill_scan.total_station_rows,
            post_route_warper_refill_scan.reservation_rows_visited,
            post_route_warper_refill_scan.dense_fallback,
            post_route_warper_refill_scan.directory_fallback,
        );
    }
    crate::interstellar_logistics::wake_dispatch_from_changed_stations(
        &post_route_warper_changed_station_indices,
        interstellar_peer_directory,
        interstellar_step_runtime,
    );
    local_step_runtime.wake_ready_from_changed_stations(&post_route_warper_changed_station_indices);
    quantum_step_runtime.wake_from_stations(&post_route_warper_changed_station_indices);
    crate::belts::wake_tracked_station_sources(
        state,
        entities,
        belt_runtime,
        belt_routes,
        &post_route_warper_changed_station_indices,
    )?;
    if profile_enabled {
        let scan = congestion_route_ledger.scan();
        eprintln!(
            "DSP_NATIVE_CORE_PROFILE\tstation-route-ledger-congestion\t{}/{}\tdense={}",
            scan.selected_demands, scan.total_candidate_rows, scan.dense_fallback
        );
    }
    let local_congestion_scan = crate::local_logistics::update_congestion(
        state,
        entities,
        local_step_runtime,
        &congestion_route_ledger,
    )?;
    execution_diagnostics.observe(
        FactoryScanStage::LocalCongestion,
        local_congestion_scan.selected_station_rows,
        local_congestion_scan.total_station_rows,
        local_congestion_scan
            .total_station_rows
            .saturating_sub(local_congestion_scan.selected_station_rows),
        local_congestion_scan.dense_fallback,
        local_congestion_scan.directory_fallback,
        local_congestion_scan.dense_fallback || local_congestion_scan.directory_fallback,
    );
    if profile_enabled {
        eprintln!(
            "DSP_NATIVE_CORE_PROFILE\tlocal-congestion-active\t{}/{}\tdense={}\tdirectory-fallback={}",
            local_congestion_scan.selected_station_rows,
            local_congestion_scan.total_station_rows,
            local_congestion_scan.dense_fallback,
            local_congestion_scan.directory_fallback,
        );
    }
    profile_mark!("local-congestion");
    let interstellar_congestion_scan = crate::interstellar_logistics::update_congestion(
        state,
        base,
        entities,
        local_step_runtime,
        interstellar_peer_directory,
        &congestion_route_ledger,
    )?;
    execution_diagnostics.observe(
        FactoryScanStage::InterstellarCongestion,
        interstellar_congestion_scan.selected_station_rows,
        interstellar_congestion_scan.total_station_rows,
        interstellar_congestion_scan
            .total_station_rows
            .saturating_sub(interstellar_congestion_scan.selected_station_rows),
        interstellar_congestion_scan.dense_fallback,
        interstellar_congestion_scan.directory_fallback
            || interstellar_congestion_scan.generation_fallback,
        interstellar_congestion_scan.dense_fallback
            || interstellar_congestion_scan.directory_fallback
            || interstellar_congestion_scan.generation_fallback,
    );
    if interstellar_congestion_scan.directory_fallback {
        std::sync::Arc::make_mut(planet_metrics_runtime).force_directory_fallback();
    }
    if profile_enabled {
        eprintln!(
            "DSP_NATIVE_CORE_PROFILE\tinterstellar-congestion-active\t{}/{}\tdense={}\tdirectory-fallback={}\tgeneration-fallback={}",
            interstellar_congestion_scan.selected_station_rows,
            interstellar_congestion_scan.total_station_rows,
            interstellar_congestion_scan.dense_fallback,
            interstellar_congestion_scan.directory_fallback,
            interstellar_congestion_scan.generation_fallback,
        );
    }
    let mut next_runtime_reset_station_indices = congestion_route_ledger.active_station_indices();
    next_runtime_reset_station_indices.extend_from_slice(&local_route_changed_station_indices);
    next_runtime_reset_station_indices.extend_from_slice(&remote_route_changed_station_indices);
    next_runtime_reset_station_indices
        .extend(quantum_step_runtime.take_runtime_written_station_indices());
    // Orbital collectors are productive station rows even without a route;
    // they write utilization/rate directly and therefore remain an explicit
    // active dependency rather than being hidden behind the route ledger.
    next_runtime_reset_station_indices
        .extend_from_slice(&state.factory_topology.orbital_collector_indices);
    writer_events.record_rows(
        FactoryWriterDomain::Logistics,
        &next_runtime_reset_station_indices,
    )?;
    std::sync::Arc::make_mut(planet_metrics_runtime)
        .wake_entity_indices(&next_runtime_reset_station_indices);
    local_step_runtime.replace_runtime_reset_station_indices(next_runtime_reset_station_indices);
    profile_mark!("interstellar-congestion");
    let exporter_powers = state
        .factory_topology
        .galactic_material_exporter_indices
        .iter()
        .copied()
        .filter_map(|entity_index| {
            let planet = state.factory_topology.entity_planet_indices[entity_index];
            let grid = state.factory_topology.entity_grid_indices[entity_index];
            (planet != usize::MAX && grid != usize::MAX).then(|| {
                (
                    entity_index,
                    power_factors
                        .get(&entity_index)
                        .copied()
                        .unwrap_or(grids[grid_slot(planet, grid)].factor),
                )
            })
        })
        .collect::<HashMap<_, _>>();
    crate::galactic_exports::run(
        state,
        base,
        entities,
        &exporter_powers,
        &power_factors,
        seconds,
    )?;
    writer_events.record_rows(
        FactoryWriterDomain::Production,
        &state.factory_topology.galactic_material_exporter_indices,
    )?;
    std::sync::Arc::make_mut(planet_metrics_runtime)
        .wake_entity_indices(&state.factory_topology.galactic_material_exporter_indices);
    profile_mark!("galactic-exports");
    crate::dyson::finalize(base)?;
    profile_mark!("logistics-dispatch-and-routes");
    if let Some(swarm) = base.get_mut("dysonSwarm").and_then(Value::as_object_mut) {
        // Keep the entity-order accumulation performed by calculate_reception.
        // Summing the HashMap here changed the IEEE-754 result by one ULP for
        // very large factories and diverged from JavaScript's insertion order.
        set_number(
            swarm,
            "receiverLoadKw",
            rounded(reception.receiver_load_kw, 2),
        )?;
    }

    let mut power_grid_metrics = Map::new();
    let mut planet_metrics = Map::new();
    for (planet, planet_id) in planet_ids.iter().enumerate() {
        let mut per_grid = Map::new();
        let mut combined = GridRuntime::default();
        for (grid, grid_id) in GRID_IDS.iter().enumerate() {
            let runtime = &grids[grid_slot(planet, grid)];
            per_grid.insert(
                (*grid_id).to_owned(),
                metric_value(Some(grid_id), runtime, 0.0),
            );
            combined.generation_kw += runtime.generation_kw;
            combined.demand_kw += runtime.demand_kw;
            combined.supplied_kw += runtime.supplied_kw;
            combined.wind_generation_kw += runtime.wind_generation_kw;
            combined.solar_generation_kw += runtime.solar_generation_kw;
            combined.geothermal_generation_kw += runtime.geothermal_generation_kw;
            combined.thermal_generation_kw += runtime.thermal_generation_kw;
            combined.fusion_generation_kw += runtime.fusion_generation_kw;
            combined.artificial_star_generation_kw += runtime.artificial_star_generation_kw;
            combined.ray_generation_kw += runtime.ray_generation_kw;
            combined.storage_discharge_kw += runtime.storage_discharge_kw;
            combined.storage_charge_kw += runtime.storage_charge_kw;
        }
        combined.factor = if combined.demand_kw <= EPSILON {
            1.0
        } else {
            combined.supplied_kw / combined.demand_kw
        };
        let (stored_mj, capacity_mj, fuel_electric_mj, rated_fuel_kw) =
            power_reserves_by_planet[planet];
        combined.stored_energy_mj = stored_mj;
        combined.storage_capacity_mj = capacity_mj;
        combined.fuel_electric_energy_mj = fuel_electric_mj;
        combined.rated_fuel_generator_kw = rated_fuel_kw;
        let total_items = total_items_before_global[planet];
        power_grid_metrics.insert(planet_id.clone(), Value::Object(per_grid));
        planet_metrics.insert(
            planet_id.clone(),
            metric_value(None, &combined, total_items),
        );
    }
    base.insert(
        "powerGridMetrics".to_owned(),
        Value::Object(power_grid_metrics),
    );
    base.insert("planetMetrics".to_owned(), Value::Object(planet_metrics));
    let active_planet = base
        .get("activePlanetId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("native simple factory active planet is missing"))?;
    let active_metrics = base
        .get("planetMetrics")
        .and_then(Value::as_object)
        .and_then(|metrics| metrics.get(active_planet))
        .cloned()
        .ok_or_else(|| anyhow!("native simple factory active planet metrics are missing"))?;
    base.insert("metrics".to_owned(), active_metrics);

    let elapsed = projected_elapsed;
    set_number(base, "elapsedSeconds", elapsed)?;
    let mut station_mode_topology_changed = false;
    if crossed_quantum_boundary {
        for boundary in first_quantum_boundary..=last_quantum_boundary {
            let (mode_changed, mode_scan) = settle_post_route_station_mode_transition(
                state,
                station_mode_transition_runtime,
                entities,
                &congestion_route_ledger,
            )?;
            execution_diagnostics.observe(
                FactoryScanStage::StationTransition,
                mode_scan.selected_rows,
                mode_scan.total_rows,
                mode_scan.total_rows.saturating_sub(mode_scan.selected_rows),
                mode_scan.dense_fallback,
                mode_scan.index_fallback || mode_scan.ledger_fallback,
                mode_scan.dense_fallback || mode_scan.index_fallback || mode_scan.ledger_fallback,
            );
            station_mode_topology_changed |= mode_changed;
            if mode_scan.index_fallback || mode_scan.ledger_fallback {
                std::sync::Arc::make_mut(planet_metrics_runtime).force_directory_fallback();
            }
            if profile_enabled {
                eprintln!(
                    "DSP_NATIVE_CORE_PROFILE\tstation-mode-transition-active\t{}/{}\ttransitions={}\troute-probes={}\tdense={}\tindex-fallback={}\tledger-fallback={}",
                    mode_scan.selected_rows,
                    mode_scan.total_rows,
                    mode_scan.transition_rows,
                    mode_scan.route_reference_probes,
                    mode_scan.dense_fallback,
                    mode_scan.index_fallback,
                    mode_scan.ledger_fallback,
                );
            }
            let (quantum_transition_changed, quantum_transition_scan) =
                crate::quantum_logistics::settle_transitions_indexed(
                    std::sync::Arc::make_mut(quantum_transition_runtime),
                    base,
                    entities,
                    interstellar_step_runtime,
                )?;
            execution_diagnostics.observe(
                FactoryScanStage::StationTransition,
                quantum_transition_scan.selected_rows,
                quantum_transition_scan.total_rows,
                quantum_transition_scan
                    .total_rows
                    .saturating_sub(quantum_transition_scan.selected_rows),
                quantum_transition_scan.dense_fallback,
                quantum_transition_scan.runtime_fallback || quantum_transition_scan.ledger_fallback,
                quantum_transition_scan.dense_fallback
                    || quantum_transition_scan.runtime_fallback
                    || quantum_transition_scan.ledger_fallback,
            );
            station_mode_topology_changed |= quantum_transition_changed;
            if quantum_transition_scan.runtime_fallback || quantum_transition_scan.ledger_fallback {
                std::sync::Arc::make_mut(planet_metrics_runtime).force_directory_fallback();
            }
            if profile_enabled {
                eprintln!(
                    "DSP_NATIVE_CORE_PROFILE\tquantum-transition-active\t{}/{}\ttransitions={}\troute-memberships={}\troute-validation={}\troute-rebuild={}\tdense={}\truntime-fallback={}\tledger-fallback={}",
                    quantum_transition_scan.selected_rows,
                    quantum_transition_scan.total_rows,
                    quantum_transition_scan.transition_rows,
                    quantum_transition_scan.route_membership_rows,
                    quantum_transition_scan.route_validation_rows,
                    quantum_transition_scan.route_rebuild_rows,
                    quantum_transition_scan.dense_fallback,
                    quantum_transition_scan.runtime_fallback,
                    quantum_transition_scan.ledger_fallback,
                );
            }
            crate::system_space_station::settle_construction(state, base, entities)?;
            crate::system_space_station::settle_hubs(
                state,
                base,
                entities,
                boundary as f64 * crate::system_space_station::boundary_seconds(),
            )?;
            let quantum_upload_flush_scan = crate::quantum_logistics::settle_uploads(
                state,
                base,
                entities,
                boundary as f64 * 5.0,
                quantum_flow.clone(),
                5.0,
                &indexed_quantum_endpoint_indices,
                quantum_step_runtime,
                &congestion_route_ledger,
                post_research_quantum_runtime_bandwidth,
            )?;
            execution_diagnostics.observe(
                FactoryScanStage::Quantum,
                quantum_upload_flush_scan.selected_rows,
                quantum_upload_flush_scan.total_rows,
                quantum_upload_flush_scan
                    .total_rows
                    .saturating_sub(quantum_upload_flush_scan.selected_rows),
                quantum_upload_flush_scan.dense_fallback,
                quantum_upload_flush_scan.directory_fallback,
                quantum_upload_flush_scan.dense_fallback
                    || quantum_upload_flush_scan.directory_fallback,
            );
            crate::quantum_logistics::record_quantum_oactive_scan(
                crate::quantum_logistics::QuantumOactiveProfileStage::Upload,
                quantum_upload_flush_scan,
            );
            if quantum_upload_flush_scan.directory_fallback {
                std::sync::Arc::make_mut(planet_metrics_runtime).force_directory_fallback();
            }
            if profile_enabled {
                eprintln!(
                    "DSP_NATIVE_CORE_PROFILE\tquantum-upload-flush-active\t{}/{}\tdense={}\tdirectory-fallback={}",
                    quantum_upload_flush_scan.selected_rows,
                    quantum_upload_flush_scan.total_rows,
                    quantum_upload_flush_scan.dense_fallback,
                    quantum_upload_flush_scan.directory_fallback,
                );
            }
        }
        let quantum_boundary_changed_station_indices =
            quantum_step_runtime.take_inventory_written_station_indices();
        writer_events.record_rows(
            FactoryWriterDomain::Quantum,
            &quantum_boundary_changed_station_indices,
        )?;
        std::sync::Arc::make_mut(planet_metrics_runtime)
            .wake_entity_indices(&quantum_boundary_changed_station_indices);
        local_step_runtime
            .wake_ready_from_changed_stations(&quantum_boundary_changed_station_indices);
        crate::interstellar_logistics::wake_dispatch_from_changed_stations(
            &quantum_boundary_changed_station_indices,
            interstellar_peer_directory,
            std::sync::Arc::make_mut(interstellar_route_activity),
        );
        crate::interstellar_logistics::wake_warper_refill_from_changed_stations(
            &quantum_boundary_changed_station_indices,
            std::sync::Arc::make_mut(interstellar_route_activity),
        );
        crate::belts::wake_tracked_station_sources(
            state,
            entities,
            belt_runtime,
            belt_routes,
            &quantum_boundary_changed_station_indices,
        )?;
        // Elevator and quantum attachment transitions can change traditional
        // peer membership. Stable five-second settlements retain the
        // cross-revision wake caches; an actual transition rebuilds once.
        refresh_station_mode_dependent_directories(
            state,
            base,
            entities,
            station_mode_topology_changed,
            local_step_directory,
            quantum_step_runtime,
            interstellar_peer_directory,
            interstellar_route_activity,
        )?;
        if station_mode_topology_changed {
            writer_events.record_topology_change();
            std::sync::Arc::make_mut(planet_metrics_runtime).force_full();
        }
    }
    profile_mark!("local-directory-boundary-refresh");
    if let Some(endgame) = base.get_mut("endgame").and_then(Value::as_object_mut) {
        let mut started = finite_number(endgame.get("exportWindowStartedAt"));
        if started <= 0.0 {
            started = elapsed;
            set_number(endgame, "exportWindowStartedAt", started)?;
        }
        if elapsed - started >= 10.0 - EPSILON {
            let amount = finite_number(endgame.get("exportWindowAmount"));
            set_number(
                endgame,
                "exportedLastMinute",
                rounded(amount * 60.0 / (elapsed - started), 2),
            )?;
            endgame.insert("exportWindowAmount".to_owned(), Value::from(0));
            set_number(endgame, "exportWindowStartedAt", elapsed)?;
        }
    }
    profile_mark!("metrics-and-global-finalize");
    Ok(SimulateStepOutcome {
        station_mode_topology_changed,
        writer_events: writer_events.seal(),
    })
}

pub(crate) struct PreparedFactoryDomains {
    pub(crate) belt_routes: std::sync::Arc<crate::belts::PreparedRoutes>,
    pub(crate) logistics_buffer_runtime:
        std::sync::Arc<crate::logistics_buffers::LogisticsBufferRuntime>,
    pub(crate) material_delivery_runtime:
        std::sync::Arc<crate::material_delivery::MaterialDeliveryRuntime>,
    pub(crate) ordinary_production_runtime:
        std::sync::Arc<crate::ordinary_production::OrdinaryProductionRuntime>,
    pub(crate) planet_metrics_runtime: std::sync::Arc<PlanetMetricsRuntime>,
    pub(crate) power_probe_runtime: std::sync::Arc<PowerProbeRuntime>,
    pub(crate) local_peer_directory: std::sync::Arc<crate::local_logistics::LocalPeerDirectory>,
    pub(crate) quantum_logistics_directory:
        std::sync::Arc<crate::quantum_logistics::QuantumLogisticsDirectory>,
    pub(crate) construction_runtime: std::sync::Arc<crate::construction::ConstructionRuntime>,
    pub(crate) station_mode_transition_runtime:
        std::sync::Arc<crate::system_space_station::ModeTransitionRuntime>,
    pub(crate) quantum_transition_runtime:
        std::sync::Arc<crate::quantum_logistics::QuantumTransitionRuntime>,
    pub(crate) interstellar_peer_directory:
        std::sync::Arc<crate::interstellar_logistics::InterstellarPeerDirectory>,
    pub(crate) interstellar_route_activity:
        std::sync::Arc<crate::interstellar_logistics::InterstellarRouteActivity>,
    pub(crate) scheduler: PartitionedPrepareDiagnostics,
}

/// Builds independent factory-domain directories against one immutable source
/// revision. Results remain candidate-local until the complete advance commits;
/// the fixed unwrap order preserves the former serial error priority.
pub(crate) fn prepare_factory_domains_with_runtime(
    state: &CoreState,
    base: &Map<String, Value>,
    entities: &[Value],
    runtime: &DeterministicRuntime,
) -> anyhow::Result<PreparedFactoryDomains> {
    let cached_belt_routes = state.prepared_belt_routes();
    let cached_logistics_buffer_runtime = state.prepared_logistics_buffer_runtime();
    let cached_material_delivery_runtime = state.prepared_material_delivery_runtime();
    let cached_ordinary_production_runtime = state.prepared_ordinary_production_runtime();
    let cached_planet_metrics_runtime = state.prepared_planet_metrics_runtime();
    let cached_power_probe_runtime = state.prepared_power_probe_runtime();
    let cached_local_peer_directory = state.prepared_local_peer_directory();
    let cached_quantum_logistics_directory = state.prepared_quantum_logistics_directory();
    let cached_construction_runtime = state.prepared_construction_runtime();
    let cached_station_mode_transition_runtime = state.prepared_station_mode_transition_runtime();
    let cached_quantum_transition_runtime = state.prepared_quantum_transition_runtime();
    let cached_interstellar_peer_directory = state.prepared_interstellar_peer_directory();
    let cached_interstellar_route_activity = state.prepared_interstellar_route_activity();
    let interstellar_is_cold = cached_interstellar_peer_directory.is_none()
        || cached_interstellar_route_activity.is_none();
    let active_mask = u8::from(cached_belt_routes.is_none())
        | (u8::from(
            cached_logistics_buffer_runtime.is_none()
                || cached_material_delivery_runtime.is_none()
                || cached_ordinary_production_runtime.is_none()
                || cached_planet_metrics_runtime.is_none()
                || cached_power_probe_runtime.is_none(),
        ) << 1)
        | (u8::from(cached_local_peer_directory.is_none()) << 2)
        | (u8::from(cached_quantum_logistics_directory.is_none()) << 3)
        | (u8::from(cached_construction_runtime.is_none()) << 4)
        | (u8::from(cached_station_mode_transition_runtime.is_none()) << 5)
        | (u8::from(cached_quantum_transition_runtime.is_none()) << 6)
        | (u8::from(interstellar_is_cold) << 7);
    let work_items = entities.len().saturating_add(state.belts.ids.len());
    let (
        (
            belt_routes,
            (
                logistics_buffer_runtime,
                material_delivery_runtime,
                ordinary_production_runtime,
                planet_metrics_runtime,
                power_probe_runtime,
            ),
            local_peer_directory,
            quantum_logistics_directory,
            construction_runtime,
            station_mode_transition_runtime,
            quantum_transition_runtime,
            interstellar,
        ),
        scheduler,
    ) = runtime.partitioned_prepare8(
        active_mask,
        work_items,
        || {
            cached_belt_routes.map_or_else(
                || {
                    crate::belts::prepare_routes_from_state(state, entities)
                        .map(std::sync::Arc::new)
                },
                Ok,
            )
        },
        || {
            (
                cached_logistics_buffer_runtime.unwrap_or_else(|| {
                    std::sync::Arc::new(crate::logistics_buffers::LogisticsBufferRuntime::build(
                        state, entities,
                    ))
                }),
                cached_material_delivery_runtime.unwrap_or_else(|| {
                    std::sync::Arc::new(crate::material_delivery::MaterialDeliveryRuntime::build(
                        state, entities,
                    ))
                }),
                cached_ordinary_production_runtime.unwrap_or_else(|| {
                    std::sync::Arc::new(
                        crate::ordinary_production::OrdinaryProductionRuntime::build(
                            state, entities,
                        ),
                    )
                }),
                cached_planet_metrics_runtime.unwrap_or_else(|| {
                    std::sync::Arc::new(PlanetMetricsRuntime::build(state, entities))
                }),
                cached_power_probe_runtime.unwrap_or_else(|| {
                    std::sync::Arc::new(PowerProbeRuntime::build(state, entities))
                }),
            )
        },
        || {
            cached_local_peer_directory.map_or_else(
                || {
                    crate::local_logistics::prepare_step_directory(
                        entities,
                        &state.factory_topology.station_indices,
                    )
                    .map(std::sync::Arc::new)
                },
                Ok,
            )
        },
        || {
            cached_quantum_logistics_directory.unwrap_or_else(|| {
                std::sync::Arc::new(crate::quantum_logistics::QuantumLogisticsDirectory::build(
                    state, entities,
                ))
            })
        },
        || {
            cached_construction_runtime.unwrap_or_else(|| {
                std::sync::Arc::new(crate::construction::ConstructionRuntime::build(
                    state, base, entities,
                ))
            })
        },
        || {
            cached_station_mode_transition_runtime.unwrap_or_else(|| {
                std::sync::Arc::new(
                    crate::system_space_station::ModeTransitionRuntime::from_entities(entities),
                )
            })
        },
        || {
            cached_quantum_transition_runtime.unwrap_or_else(|| {
                std::sync::Arc::new(crate::quantum_logistics::QuantumTransitionRuntime::build(
                    entities,
                ))
            })
        },
        || {
            let mut activity = cached_interstellar_route_activity.unwrap_or_else(|| {
                std::sync::Arc::new(crate::interstellar_logistics::prepare_route_activity(
                    entities,
                ))
            });
            let directory = cached_interstellar_peer_directory.unwrap_or_else(|| {
                let directory = std::sync::Arc::new(
                    crate::interstellar_logistics::InterstellarPeerDirectory::build(
                        state, base, entities,
                    ),
                );
                crate::interstellar_logistics::reset_dispatch_wakes(
                    &directory,
                    std::sync::Arc::make_mut(&mut activity),
                );
                directory
            });
            (directory, activity)
        },
    );

    // Stable serial validation is also the candidate publication boundary.
    // A later Result never wins over an earlier partition, and no prepared
    // cache is installed into CoreState until the full revision commits.
    let belt_routes = belt_routes?;
    let local_peer_directory = local_peer_directory?;
    let (mut interstellar_peer_directory, mut interstellar_route_activity) = interstellar;
    crate::interstellar_logistics::refresh_peer_directory(
        state,
        base,
        entities,
        false,
        &mut interstellar_peer_directory,
        &mut interstellar_route_activity,
    );
    Ok(PreparedFactoryDomains {
        belt_routes,
        logistics_buffer_runtime,
        material_delivery_runtime,
        ordinary_production_runtime,
        planet_metrics_runtime,
        power_probe_runtime,
        local_peer_directory,
        quantum_logistics_directory,
        construction_runtime,
        station_mode_transition_runtime,
        quantum_transition_runtime,
        interstellar_peer_directory,
        interstellar_route_activity,
        scheduler,
    })
}

pub(crate) struct PreparedFactoryAdvance {
    pub base: Map<String, Value>,
    pub entities: Vec<Value>,
    pub belt_commit: crate::belts::BeltCommitBatch,
    pub belt_flow: crate::belts::PreparedBeltFlow,
    pub belt_scheduler: crate::belts::BeltSchedulerDiagnostics,
    pub belt_routes: std::sync::Arc<crate::belts::PreparedRoutes>,
    pub belt_activity: std::sync::Arc<crate::belts::BeltActivitySnapshot>,
    pub logistics_buffer_runtime: std::sync::Arc<crate::logistics_buffers::LogisticsBufferRuntime>,
    pub material_delivery_runtime:
        std::sync::Arc<crate::material_delivery::MaterialDeliveryRuntime>,
    pub ordinary_production_runtime:
        std::sync::Arc<crate::ordinary_production::OrdinaryProductionRuntime>,
    pub planet_metrics_runtime: std::sync::Arc<PlanetMetricsRuntime>,
    pub power_probe_runtime: std::sync::Arc<PowerProbeRuntime>,
    pub local_peer_directory: std::sync::Arc<crate::local_logistics::LocalPeerDirectory>,
    pub quantum_logistics_directory:
        std::sync::Arc<crate::quantum_logistics::QuantumLogisticsDirectory>,
    pub construction_runtime: std::sync::Arc<crate::construction::ConstructionRuntime>,
    pub station_mode_transition_runtime:
        std::sync::Arc<crate::system_space_station::ModeTransitionRuntime>,
    pub quantum_transition_runtime:
        std::sync::Arc<crate::quantum_logistics::QuantumTransitionRuntime>,
    pub interstellar_peer_directory:
        std::sync::Arc<crate::interstellar_logistics::InterstellarPeerDirectory>,
    pub interstellar_route_activity:
        std::sync::Arc<crate::interstellar_logistics::InterstellarRouteActivity>,
    /// Stable writer manifest shared by active selectors, statistics and the
    /// diagnostics projection. It is candidate-local until the state commit.
    pub writer_events: SealedFactoryWriterEvents,
    pub factory_execution_diagnostics: FactoryExecutionDiagnostics,
    /// `Some` is the writer-closed persisted-order set for Campaign metrics;
    /// `None` means a topology transition requires lazy flat reconstruction.
    pub campaign_metric_writer_indices: Option<Vec<usize>>,
    /// Disposable private statistics tiers advanced alongside every public
    /// one-second history sample. The sealed candidate is installed only by
    /// the same successful state commit as its final public base.
    pub production_history_tiers: Option<crate::production_history::TieredProductionHistory>,
}

pub(crate) fn prepare_advance(
    state: &CoreState,
    simulation_seconds: f64,
    wall_seconds: f64,
    isolate_construction_automation: bool,
) -> anyhow::Result<PreparedFactoryAdvance> {
    prepare_advance_with_runtime(
        state,
        simulation_seconds,
        wall_seconds,
        isolate_construction_automation,
        deterministic_runtime(),
    )
}

fn should_record_internal_exact_seconds(
    base: &Map<String, Value>,
    total: f64,
    step_size: f64,
) -> bool {
    let history_clock_aligned = (finite_number(base.get("elapsedSeconds"))
        - finite_number(base.get("historyRecordedAt")))
    .abs()
        <= EPSILON;
    total > EPSILON
        && (total - total.round()).abs() <= EPSILON
        && step_size <= 1.0 + EPSILON
        && history_clock_aligned
}

fn synchronize_active_planet_tray(base: &mut Map<String, Value>) -> anyhow::Result<()> {
    if let (Some(active_planet), Some(tray)) = (
        base.get("activePlanetId")
            .and_then(Value::as_str)
            .map(str::to_owned),
        base.get("tray").cloned(),
    ) {
        base.get_mut("planetTrays")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native active planet trays are missing"))?
            .insert(active_planet, tray);
    }
    Ok(())
}

fn finalize_public_factory_boundary_before_history(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entities: &mut [Value],
) -> anyhow::Result<()> {
    settle_completed_research_boundaries(state, base, entities)?;
    if let Some(time_warp) = base.get_mut("timeWarp").and_then(Value::as_object_mut) {
        set_number(time_warp, "pendingSimulationSeconds", 0.0)?;
        set_number(time_warp, "pendingWallSeconds", 0.0)?;
    }
    let universe_matrix = number_at(base.get("totalProduced"), &["universe_matrix"]);
    if base.get("mode").and_then(Value::as_str) == Some("normal")
        && universe_matrix >= 1.0
        && let Some(station) = base
            .get_mut("orbitalStation")
            .and_then(Value::as_object_mut)
        && station.get("status").and_then(Value::as_str) == Some("locked")
    {
        station.insert("status".to_owned(), Value::from("eligible"));
    }
    Ok(())
}

fn prepare_advance_with_runtime(
    state: &CoreState,
    simulation_seconds: f64,
    wall_seconds: f64,
    isolate_construction_automation: bool,
    deterministic_runtime: &DeterministicRuntime,
) -> anyhow::Result<PreparedFactoryAdvance> {
    prepare_advance_with_runtime_options(
        state,
        simulation_seconds,
        wall_seconds,
        isolate_construction_automation,
        deterministic_runtime,
        MaterialDeliveryDrainMode::Indexed,
        PlanetMetricProbeMode::Indexed,
        PowerProbeMode::Indexed,
        None,
    )
}

#[cfg(test)]
fn prepare_advance_with_material_delivery_test_options(
    state: &CoreState,
    simulation_seconds: f64,
    wall_seconds: f64,
    isolate_construction_automation: bool,
    deterministic_runtime: &DeterministicRuntime,
    material_delivery_mode: MaterialDeliveryDrainMode,
    step_size_override: Option<f64>,
) -> anyhow::Result<PreparedFactoryAdvance> {
    prepare_advance_with_runtime_options(
        state,
        simulation_seconds,
        wall_seconds,
        isolate_construction_automation,
        deterministic_runtime,
        material_delivery_mode,
        PlanetMetricProbeMode::Indexed,
        PowerProbeMode::Indexed,
        step_size_override,
    )
}

#[cfg(test)]
fn prepare_advance_with_planet_metric_test_options(
    state: &CoreState,
    simulation_seconds: f64,
    wall_seconds: f64,
    isolate_construction_automation: bool,
    deterministic_runtime: &DeterministicRuntime,
    planet_metric_mode: PlanetMetricProbeMode,
    step_size_override: Option<f64>,
) -> anyhow::Result<PreparedFactoryAdvance> {
    prepare_advance_with_runtime_options(
        state,
        simulation_seconds,
        wall_seconds,
        isolate_construction_automation,
        deterministic_runtime,
        MaterialDeliveryDrainMode::Indexed,
        planet_metric_mode,
        PowerProbeMode::Indexed,
        step_size_override,
    )
}

#[cfg(test)]
fn prepare_advance_with_power_probe_test_options(
    state: &CoreState,
    simulation_seconds: f64,
    wall_seconds: f64,
    isolate_construction_automation: bool,
    deterministic_runtime: &DeterministicRuntime,
    power_probe_mode: PowerProbeMode,
    step_size_override: Option<f64>,
) -> anyhow::Result<PreparedFactoryAdvance> {
    prepare_advance_with_runtime_options(
        state,
        simulation_seconds,
        wall_seconds,
        isolate_construction_automation,
        deterministic_runtime,
        MaterialDeliveryDrainMode::Indexed,
        PlanetMetricProbeMode::Indexed,
        power_probe_mode,
        step_size_override,
    )
}

#[allow(clippy::too_many_arguments)]
fn prepare_advance_with_runtime_options(
    state: &CoreState,
    simulation_seconds: f64,
    wall_seconds: f64,
    isolate_construction_automation: bool,
    deterministic_runtime: &DeterministicRuntime,
    material_delivery_mode: MaterialDeliveryDrainMode,
    planet_metric_mode: PlanetMetricProbeMode,
    power_probe_mode: PowerProbeMode,
    step_size_override: Option<f64>,
) -> anyhow::Result<PreparedFactoryAdvance> {
    let profile_enabled = crate::profile_evidence::profile_environment_enabled();
    let quantum_oactive_profile =
        crate::quantum_logistics::QuantumOactiveProfileGuard::begin_if_requested();
    let mut profile_checkpoint = profile_enabled.then(std::time::Instant::now);
    if profile_enabled {
        eprintln!(
            "DSP_NATIVE_CORE_PROFILE\truntime-worker-limit\t{}",
            deterministic_runtime.worker_limit()
        );
        eprintln!(
            "DSP_NATIVE_CORE_PROFILE\truntime-observed-workers\t{}",
            deterministic_runtime.observed_worker_count()
        );
    }
    macro_rules! profile_mark {
        ($label:literal) => {
            if let Some(checkpoint) = profile_checkpoint.as_mut() {
                eprintln!(
                    "DSP_NATIVE_CORE_PROFILE\tstate-{}\t{:.3}",
                    $label,
                    checkpoint.elapsed().as_secs_f64() * 1_000.0
                );
                *checkpoint = std::time::Instant::now();
            }
        };
    }
    let mut entities = state.take_entities_for_simulation()?;
    // JS copyState() materializes both sparse runtime maps before either a
    // simulation step or a wall-clock-only speedrun advance. Mirror that
    // shape here so a zero-simulation budget remains canonically exact.
    deterministic_runtime.indexed_for_each_mut(&mut entities, |_, entity| {
        let Some(entity) = entity.as_object_mut() else {
            return;
        };
        if !entity.contains_key("stationLastSupplyPeerBySlot") {
            entity.insert(
                "stationLastSupplyPeerBySlot".to_owned(),
                Value::Object(Map::new()),
            );
        }
        if !entity.contains_key("proliferatorBonusProgress") {
            entity.insert(
                "proliferatorBonusProgress".to_owned(),
                Value::Object(Map::new()),
            );
        }
    });
    let mut base = state.base_value().clone();
    profile_mark!("parse-records");
    let prepared_domains =
        prepare_factory_domains_with_runtime(state, &base, &entities, deterministic_runtime)?;
    let mut factory_execution_diagnostics = FactoryExecutionDiagnosticsBuilder::new(
        state.revision,
        deterministic_runtime.worker_limit(),
        deterministic_runtime.observed_worker_count(),
    );
    factory_execution_diagnostics.observe_prepare(prepared_domains.scheduler.parallel);
    if profile_enabled {
        let scheduler = prepared_domains.scheduler;
        eprintln!(
            "DSP_NATIVE_CORE_PROFILE\tpartitioned-factory-domain-prepare\tactive={}/8\twork-items={}\tselected-workers={}\tobserved-workers={}\tparallel={}",
            scheduler.active_partitions,
            scheduler.work_items,
            scheduler.selected_worker_count,
            scheduler.observed_worker_count,
            scheduler.parallel,
        );
    }
    let mut belt_routes = prepared_domains.belt_routes;
    let mut logistics_buffer_runtime = prepared_domains.logistics_buffer_runtime;
    let mut material_delivery_runtime = prepared_domains.material_delivery_runtime;
    let mut ordinary_production_runtime = prepared_domains.ordinary_production_runtime;
    let mut planet_metrics_runtime = prepared_domains.planet_metrics_runtime;
    let mut power_probe_runtime = prepared_domains.power_probe_runtime;
    let mut local_peer_directory = prepared_domains.local_peer_directory;
    let mut quantum_logistics_directory = prepared_domains.quantum_logistics_directory;
    let mut construction_runtime = prepared_domains.construction_runtime;
    let mut station_mode_transition_runtime = prepared_domains.station_mode_transition_runtime;
    let mut quantum_transition_runtime = prepared_domains.quantum_transition_runtime;
    let mut interstellar_peer_directory = prepared_domains.interstellar_peer_directory;
    let mut interstellar_route_activity = prepared_domains.interstellar_route_activity;
    profile_mark!("partitioned-domain-prepare");
    let mut belt_runtime = crate::belts::BeltRuntime::from_state(
        state,
        &entities,
        &belt_routes,
        state.prepared_belt_activity(),
    )?;
    synchronize_active_planet_tray(&mut base)?;
    settle_completed_research_boundaries(state, &mut base, &mut entities)?;
    profile_mark!("research-boundaries-before");
    let total = simulation_seconds;
    let mut step_size: f64 = if total >= 24.0 * 60.0 * 60.0 {
        30.0
    } else if total > 8.0 * 60.0 * 60.0 {
        10.0
    } else {
        1.0
    };
    if state
        .factory_topology
        .orbital_cargo_terminal_indices
        .iter()
        .any(|&index| {
            entities[index]
                .as_object()
                .and_then(|entity| entity.get("orbitalCargoBinding"))
                .is_some_and(|binding| !binding.is_null())
        })
    {
        step_size = step_size.min(5.0);
    }
    if entities
        .iter()
        .filter_map(Value::as_object)
        .any(crate::system_space_station::is_elevator)
    {
        step_size = step_size.min(crate::system_space_station::boundary_seconds());
    }
    if let Some(override_seconds) = step_size_override {
        debug_assert!(matches!(override_seconds, 1.0 | 10.0 | 30.0));
        step_size = override_seconds;
    }
    // A whole-second public Exact request must be observationally identical
    // to the same request split into one-second commits. Preserve the legacy
    // single-boundary behavior for fractional/unaligned calls and for the
    // established >8h 10/30-second stepping policy; those paths require a
    // separate admission decision rather than a silent semantic rewrite.
    let record_internal_exact_seconds =
        should_record_internal_exact_seconds(&base, total, step_size);
    let mut production_history_tiers =
        record_internal_exact_seconds.then(|| state.production_history_tiers_candidate());
    let mut remaining = total;
    let mut remaining_wall = wall_seconds.max(0.0);
    let wall_per_simulation_second = if total > EPSILON {
        remaining_wall / total
    } else {
        0.0
    };
    let initial_activity_clock_ms = base
        .get("endgame")
        .and_then(Value::as_object)
        .and_then(|endgame| endgame.get("constructionActivity"))
        .and_then(Value::as_object)
        .map(|activity| finite_number(activity.get("activityClockMs")))
        .unwrap_or(0.0);
    let mut advanced_wall = 0.0;
    let mut campaign_metric_writer_indices = Some(Vec::<usize>::new());
    let mut factory_writer_events = FactoryWriterEvents::new(state.revision, entities.len());
    while remaining > EPSILON {
        let mut step = remaining.min(step_size);
        if record_internal_exact_seconds {
            let elapsed = finite_number(base.get("elapsedSeconds"));
            let recorded = finite_number(base.get("historyRecordedAt"));
            let until_history_boundary = recorded + 1.0 - elapsed;
            if until_history_boundary > EPSILON && until_history_boundary < step - EPSILON {
                step = until_history_boundary;
            }
        }
        if wall_per_simulation_second > EPSILON
            && let Some(activity) = base
                .get("endgame")
                .and_then(Value::as_object)
                .and_then(|endgame| endgame.get("constructionActivity"))
                .and_then(Value::as_object)
                .filter(|activity| {
                    activity
                        .get("activityId")
                        .and_then(Value::as_str)
                        .is_some_and(|id| !id.is_empty())
                })
        {
            let clock = finite_number(activity.get("activityClockMs"));
            for boundary_key in ["startsAtMs", "endsAtMs"] {
                let until_boundary_wall =
                    (finite_number(activity.get(boundary_key)) - clock) / 1_000.0;
                let until_boundary_simulation = until_boundary_wall / wall_per_simulation_second;
                if until_boundary_simulation > EPSILON && until_boundary_simulation < step - EPSILON
                {
                    step = until_boundary_simulation;
                }
            }
        }
        let step_outcome = simulate_step(
            state,
            &mut base,
            &mut entities,
            &mut belt_runtime,
            &belt_routes,
            &mut logistics_buffer_runtime,
            &mut material_delivery_runtime,
            material_delivery_mode,
            &mut ordinary_production_runtime,
            &mut planet_metrics_runtime,
            planet_metric_mode,
            &mut power_probe_runtime,
            power_probe_mode,
            &mut local_peer_directory,
            &mut quantum_logistics_directory,
            &mut construction_runtime,
            &mut station_mode_transition_runtime,
            &mut quantum_transition_runtime,
            &mut interstellar_peer_directory,
            &mut interstellar_route_activity,
            &mut factory_execution_diagnostics,
            deterministic_runtime,
            step,
            isolate_construction_automation,
        )
        .context("advance native simple factory step")?;
        factory_writer_events.merge(&step_outcome.writer_events)?;
        if step_outcome.station_mode_topology_changed {
            campaign_metric_writer_indices = None;
            let rebuilt_belt_routes = std::sync::Arc::new(
                crate::belts::prepare_routes_from_state(state, &entities)
                    .context("rebuild native belt routes after station mode transition")?,
            );
            belt_runtime
                .rebuild_activity_for_routes(state, &entities, &belt_routes, &rebuilt_belt_routes)
                .context("rebuild native belt activity after station mode transition")?;
            belt_routes = rebuilt_belt_routes;
        } else if let Some(indices) = campaign_metric_writer_indices.as_mut() {
            indices.extend_from_slice(step_outcome.writer_events.rows(FactoryWriterDomain::Route));
        }
        let wall_step = remaining_wall.min(step * wall_per_simulation_second);
        if wall_step > 0.0 {
            advanced_wall += wall_step;
            if let Some(activity) = base
                .get_mut("endgame")
                .and_then(Value::as_object_mut)
                .and_then(|endgame| endgame.get_mut("constructionActivity"))
                .and_then(Value::as_object_mut)
                .filter(|activity| {
                    activity
                        .get("activityId")
                        .and_then(Value::as_str)
                        .is_some_and(|id| !id.is_empty())
                })
            {
                set_number(
                    activity,
                    "activityClockMs",
                    (initial_activity_clock_ms + advanced_wall * 1_000.0)
                        .floor()
                        .max(0.0),
                )?;
            }
            crate::speedrun::advance_clock(state, &mut base, wall_step)?;
        }
        let remaining_after_step = (remaining - step).max(0.0);
        let history_boundary_due = finite_number(base.get("elapsedSeconds"))
            - finite_number(base.get("historyRecordedAt"))
            >= 1.0 - EPSILON;
        if record_internal_exact_seconds && remaining_after_step > EPSILON && history_boundary_due {
            finalize_public_factory_boundary_before_history(state, &mut base, &mut entities)?;
            let flow_requirement = crate::production_history::belt_flow_requirement(&base)?;
            let prepared_belt_flow = belt_runtime.prepared_flow(flow_requirement)?;
            let cumulative_history_writer_events = factory_writer_events.clone().seal();
            let history_record = state.record_production_history_for_exact_step(
                &mut base,
                &entities,
                prepared_belt_flow,
                Some(&cumulative_history_writer_events),
                deterministic_runtime,
            )?;
            if let crate::production_history::InternalExactHistoryRecord::Recorded(
                campaign_metrics,
            ) = history_record
            {
                production_history_tiers
                    .as_mut()
                    .expect("exact history tier candidate must exist")
                    .refresh_after_internal_sample(&base);
                crate::campaign::synchronize_with_factory_metrics(
                    state,
                    &mut base,
                    &entities,
                    campaign_metrics,
                )?;
                crate::campaign::synchronize_orbital_station_eligibility(&mut base)?;
                crate::speedrun::evaluate(state, &mut base)?;
                // A segmented public call copies the active tray back into
                // its planet slot before beginning the next simulation
                // second. Preserve that call-boundary normalization here.
                synchronize_active_planet_tray(&mut base)?;
            }
        }
        remaining = remaining_after_step;
        remaining_wall = (remaining_wall - wall_step).max(0.0);
    }
    if total <= EPSILON && remaining_wall > EPSILON {
        if let Some(activity) = base
            .get_mut("endgame")
            .and_then(Value::as_object_mut)
            .and_then(|endgame| endgame.get_mut("constructionActivity"))
            .and_then(Value::as_object_mut)
            .filter(|activity| {
                activity
                    .get("activityId")
                    .and_then(Value::as_str)
                    .is_some_and(|id| !id.is_empty())
            })
        {
            set_number(
                activity,
                "activityClockMs",
                (initial_activity_clock_ms + remaining_wall * 1_000.0)
                    .floor()
                    .max(0.0),
            )?;
        }
        crate::speedrun::advance_clock(state, &mut base, remaining_wall)?;
    }
    if let Some(indices) = campaign_metric_writer_indices.as_mut() {
        indices.sort_unstable();
        indices.dedup();
    }
    let writer_events = factory_writer_events.seal();
    let factory_execution_diagnostics = factory_execution_diagnostics.finish(
        state
            .revision
            .checked_add(1)
            .ok_or_else(|| anyhow!("native core revision exhausted"))?,
        &writer_events,
    );
    profile_mark!("simulate-steps");
    let belt_activity = belt_runtime.activity_snapshot(&belt_routes);
    let belt_flow_requirement = crate::production_history::belt_flow_requirement(&base)?;
    let (belt_commit, belt_flow, belt_scheduler) =
        belt_runtime.into_patches(state, belt_flow_requirement)?;
    profile_mark!("belt-runtime-write-back");
    finalize_public_factory_boundary_before_history(state, &mut base, &mut entities)?;
    profile_mark!("research-boundaries-after");
    if let Some(mut structured_profile) = quantum_oactive_profile.finish() {
        let binding = crate::profile_evidence::current_profile_operation_binding()
            .filter(|binding| {
                binding.purpose()
                    == crate::profile_evidence::ProfileOperationPurpose::QuantumOactiveShapeV1
            })
            .expect("quantum O(active) profile binding must remain installed");
        structured_profile
            .as_object_mut()
            .expect("quantum O(active) profile evidence must be an object")
            .insert(
                "operationBinding".to_owned(),
                json!({
                    "protocol": "native-core-advance-profile-v1",
                    "requestId": binding.request_id(),
                    "sessionIdSha256": hex::encode(binding.session_id_sha256()),
                    "baseRevision": binding.base_revision(),
                    "expectedMeasuredRevision": binding.expected_measured_revision(),
                    "profilePurpose": binding.purpose().as_str(),
                }),
            );
        eprintln!(
            "DSP_NATIVE_CORE_PROFILE_RECORD_DIAGNOSTIC\t{}",
            structured_profile,
        );
        let captured =
            crate::profile_evidence::record_profile_operation_evidence(structured_profile);
        eprintln!("DSP_NATIVE_CORE_PROFILE_RECORD_CAPTURED\t{captured}");
    }
    Ok(PreparedFactoryAdvance {
        base,
        entities,
        belt_commit,
        belt_flow,
        belt_scheduler,
        belt_routes,
        belt_activity,
        logistics_buffer_runtime,
        material_delivery_runtime,
        ordinary_production_runtime,
        planet_metrics_runtime,
        power_probe_runtime,
        local_peer_directory,
        quantum_logistics_directory,
        construction_runtime,
        station_mode_transition_runtime,
        quantum_transition_runtime,
        interstellar_peer_directory,
        interstellar_route_activity,
        writer_events,
        factory_execution_diagnostics,
        campaign_metric_writer_indices,
        production_history_tiers,
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::catalog::{
        BeltDefinition, BuildingDefinition, CatalogSnapshot, ConstructionDefinition, ItemAmount,
        ItemDefinition, PlanetDefinition, ProliferatorDefinition, RecipeDefinition, RuntimeCatalog,
        TechnologyDefinition,
    };
    use crate::command::{PathSegment, RecordPatch, SimulationCommandPatch, ValuePatch};
    use crate::simulation::{CoreAdvanceMode, CoreAdvanceRequest};
    use crate::state::CoreCheckpointIdentity;
    use serde_json::json;
    use sha2::Digest;
    use std::collections::BTreeMap;
    use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};

    #[test]
    fn construction_power_group_matches_forced_full_at_critical_supply_and_fails_closed() {
        let other = PowerDemandProbe {
            entity_index: 4,
            planet_index: 0,
            grid_index: 0,
            demand_kw: 3_000.0,
            priority: 1,
            demand_active: true,
            zero_if_disconnected: true,
        };
        let centers = (0..8)
            .map(|offset| PowerDemandProbe {
                entity_index: 10 + offset,
                planet_index: 0,
                grid_index: 0,
                demand_kw: 12_000.0,
                priority: 2,
                demand_active: true,
                zero_if_disconnected: true,
            })
            .collect::<Vec<_>>();
        let group = crate::construction::ConstructionPowerGroupDemand {
            representative_entity_index: 10,
            planet_index: 0,
            grid_index: 0,
            priority: 2,
            demand_kw: 96_000.0,
            center_count: 8,
        };
        assert!(construction_power_aggregation_is_exact(
            &[std::slice::from_ref(&other)],
            &[group],
            GRID_IDS.len(),
        ));

        let mut full = vec![GridRuntime::default(); GRID_IDS.len()];
        let mut indexed = vec![GridRuntime::default(); GRID_IDS.len()];
        full[0].has_power_source = true;
        indexed[0].has_power_source = true;
        let mut full_disconnected = Vec::new();
        let mut indexed_disconnected = Vec::new();
        apply_power_demand_probe(other, &mut full, &mut full_disconnected);
        for center in centers {
            apply_power_demand_probe(center, &mut full, &mut full_disconnected);
        }
        apply_power_demand_probe(other, &mut indexed, &mut indexed_disconnected);
        apply_construction_power_group(group, &mut indexed, &mut indexed_disconnected);
        assert_eq!(full[0].connected_entities, indexed[0].connected_entities);
        assert_eq!(full_disconnected, indexed_disconnected);
        let full_total = full[0]
            .consumers
            .iter()
            .flat_map(|consumers| consumers.iter())
            .map(|consumer| consumer.demand_kw)
            .sum::<f64>();
        let indexed_total = indexed[0]
            .consumers
            .iter()
            .flat_map(|consumers| consumers.iter())
            .map(|consumer| consumer.demand_kw)
            .sum::<f64>();
        assert_eq!(full_total.to_bits(), indexed_total.to_bits());
        let full_construction_demand = full[0].consumers[2]
            .iter()
            .map(|consumer| consumer.demand_kw)
            .sum::<f64>();
        let indexed_construction_demand = indexed[0].consumers[2]
            .iter()
            .map(|consumer| consumer.demand_kw)
            .sum::<f64>();
        for expected_factor in [EPSILON - 0.00000001, EPSILON + 0.00000001] {
            let supplied = full_construction_demand * expected_factor;
            let full_factor = (supplied / full_construction_demand).min(1.0);
            let indexed_factor = (supplied / indexed_construction_demand).min(1.0);
            assert_eq!(full_factor.to_bits(), indexed_factor.to_bits());
            assert_eq!(full_factor <= EPSILON, expected_factor <= EPSILON);
        }

        let fractional = PowerDemandProbe {
            demand_kw: 0.5,
            ..other
        };
        assert!(!construction_power_aggregation_is_exact(
            &[std::slice::from_ref(&fractional)],
            &[group],
            GRID_IDS.len(),
        ));
        let oversized = crate::construction::ConstructionPowerGroupDemand {
            demand_kw: 9_007_199_254_740_992.0,
            ..group
        };
        assert!(!construction_power_aggregation_is_exact(
            &[],
            &[oversized],
            GRID_IDS.len(),
        ));
    }

    #[test]
    fn empty_quantum_boundary_does_not_claim_late_station_inventory_change() {
        assert!(!quantum_boundary_changed_station_inventory(None));
        assert!(!quantum_boundary_changed_station_inventory(Some(
            &crate::quantum_logistics::BoundaryFlow::default()
        )));
    }

    fn fixture_checksum(bytes: &[u8]) -> String {
        let mut hash = 0x811c9dc5_u32;
        for byte in bytes {
            hash ^= u32::from(*byte);
            hash = hash.wrapping_mul(0x01000193);
        }
        format!("{hash:08x}")
    }

    fn fixture_building(id: &str) -> BuildingDefinition {
        let renewable = is_independent_renewable_power_facility(id);
        let fuel_generator = id == "thermal_power_plant";
        BuildingDefinition {
            id: id.to_owned(),
            kind: match id {
                "storage_mk1" | "material_delivery_hub" => "storage",
                "splitter" => "splitter",
                _ if renewable || fuel_generator => "power",
                _ => "machine",
            }
            .to_owned(),
            speed: 1.0,
            input_capacity: 100.0,
            output_capacity: 100.0,
            power_demand_kw: if renewable { 0.0 } else { 1.0 },
            power_generation_kw: match id {
                "wind_turbine" => 300.0,
                "solar_panel" => 360.0,
                "geothermal_power_station" => 4_800.0,
                "thermal_power_plant" => 2_160.0,
                _ => 0.0,
            },
            power_charge_kw: 0.0,
            energy_capacity_mj: 0.0,
            fuel_item_ids: fuel_generator
                .then(|| "coal".to_owned())
                .into_iter()
                .collect(),
            fuel_efficiency: 1.0,
            family: Some("smelting".to_owned()),
            accepts: None,
        }
    }

    fn fixture_recipe(
        id: &str,
        building_id: &str,
        required_tech_id: Option<&str>,
        inputs: Vec<ItemAmount>,
        outputs: Vec<ItemAmount>,
    ) -> RecipeDefinition {
        RecipeDefinition {
            id: id.to_owned(),
            name: id.to_owned(),
            building_id: building_id.to_owned(),
            duration: 1.0,
            required_tech_id: required_tech_id.map(str::to_owned),
            recursive_priority: 0.0,
            recursive_manufacturing: false,
            inputs,
            outputs,
        }
    }

    fn fixture_catalog_with_registry(registry_fingerprint: &str) -> RuntimeCatalog {
        let input = || ItemAmount {
            item_id: "iron_ore".to_owned(),
            amount: 1.0,
        };
        let output = || ItemAmount {
            item_id: "iron_ingot".to_owned(),
            amount: 1.0,
        };
        RuntimeCatalog::validate(
            CatalogSnapshot {
                protocol_version: 1,
                registry_fingerprint: registry_fingerprint.to_owned(),
                planets: vec![PlanetDefinition {
                    id: "home".to_owned(),
                    name: "home".to_owned(),
                    system_id: "helios".to_owned(),
                    kind: "terrestrial".to_owned(),
                    orbit_index: 1,
                    simulation_order: 0,
                    orbital_yields: HashMap::new(),
                }],
                items: [
                    ("iron_ore", "solid"),
                    ("iron_ingot", "solid"),
                    ("coal", "solid"),
                    ("proliferator_mk1", "solid"),
                    ("universe_matrix", "matrix"),
                    ("solar_sail", "solid"),
                    ("small_carrier_rocket", "solid"),
                ]
                .into_iter()
                .map(|(id, kind)| ItemDefinition {
                    id: id.to_owned(),
                    name: id.to_owned(),
                    kind: kind.to_owned(),
                    fuel_energy_mj: if id == "coal" { 2.7 } else { 0.0 },
                })
                .collect(),
                buildings: [
                    "arc_smelter",
                    "matrix_lab",
                    "em_rail_ejector",
                    "vertical_launching_silo",
                    "mining_machine",
                    "interstellar_logistics_station",
                    "orbital_collector",
                    "construction_center",
                    "wind_turbine",
                    "solar_panel",
                    "geothermal_power_station",
                    "thermal_power_plant",
                    "storage_mk1",
                    "material_delivery_hub",
                    "splitter",
                ]
                .into_iter()
                .map(fixture_building)
                .collect(),
                recipes: vec![
                    fixture_recipe(
                        "iron_ingot",
                        "arc_smelter",
                        None,
                        vec![input()],
                        vec![output()],
                    ),
                    fixture_recipe(
                        "locked_ingot",
                        "arc_smelter",
                        Some("locked_tech"),
                        vec![input()],
                        vec![output()],
                    ),
                    fixture_recipe("matrix_research", "matrix_lab", None, vec![], vec![]),
                    fixture_recipe(
                        "solar_sail_launch",
                        "em_rail_ejector",
                        None,
                        vec![ItemAmount {
                            item_id: "solar_sail".to_owned(),
                            amount: 1.0,
                        }],
                        vec![],
                    ),
                    fixture_recipe(
                        "carrier_rocket_launch",
                        "vertical_launching_silo",
                        None,
                        vec![ItemAmount {
                            item_id: "small_carrier_rocket".to_owned(),
                            amount: 1.0,
                        }],
                        vec![],
                    ),
                    fixture_recipe(
                        "mod:wide-output",
                        "arc_smelter",
                        None,
                        vec![input()],
                        (0..=MAX_PARALLEL_LOCAL_MACHINE_OUTPUTS)
                            .map(|_| output())
                            .collect(),
                    ),
                ],
                constructions: vec![ConstructionDefinition {
                    id: "test_building".to_owned(),
                    output_amount: 1.0,
                    automation_order: 0,
                    required_tech_id: None,
                    costs: vec![ItemAmount {
                        item_id: "iron_ore".to_owned(),
                        amount: 1.0,
                    }],
                }],
                belts: vec![BeltDefinition {
                    tier: 1,
                    speed: 6.0,
                }],
                proliferators: vec![ProliferatorDefinition {
                    tier: 1,
                    item_id: "proliferator_mk1".to_owned(),
                    spray_points: 4.0,
                    extra_product_bonus: 0.25,
                    speed_bonus: 0.5,
                    power_multiplier: 1.5,
                    required_tech_id: "proliferator_1".to_owned(),
                }],
                technologies: vec![
                    TechnologyDefinition {
                        id: "research_speed_1".to_owned(),
                        name: "research_speed_1".to_owned(),
                        costs: vec![ItemAmount {
                            item_id: "universe_matrix".to_owned(),
                            amount: 100_000.0,
                        }],
                        prerequisites: Vec::new(),
                        construction_rewards: Vec::new(),
                    },
                    TechnologyDefinition {
                        id: "mining_speed_1".to_owned(),
                        name: "mining_speed_1".to_owned(),
                        costs: vec![ItemAmount {
                            item_id: "universe_matrix".to_owned(),
                            amount: 200_000.0,
                        }],
                        prerequisites: vec!["research_speed_1".to_owned()],
                        construction_rewards: Vec::new(),
                    },
                ],
            },
            registry_fingerprint,
        )
        .unwrap()
    }

    fn fixture_base() -> Value {
        json!({
            "version": 47,
            "mode": "normal",
            "activePlanetId": "home",
            "elapsedSeconds": 0,
            "paused": false,
            "settings": { "difficulty": "standard" },
            "research": {
                "completedTechIds": ["proliferator_1"],
                "selectedTechId": null,
                "progressByTech": {}
            },
            "endgame": { "infiniteResearch": { "matrix_compression": { "level": 0 } } },
            "totalProduced": {}
        })
    }

    fn machine_entity(id: impl Into<String>, building_id: &str, recipe_id: &str) -> Value {
        json!({
            "id": id.into(),
            "kind": "machine",
            "planetId": "home",
            "powerGridId": "grid-a",
            "buildingId": building_id,
            "recipeId": recipe_id,
            "machineCount": 1,
            "minerCount": 0,
            "inputs": { "iron_ore": 100, "proliferator_mk1": 10 },
            "outputs": { "iron_ingot": 0 },
            "progress": 0.25,
            "utilization": 0,
            "productionRate": 0,
            "routingCursor": 0,
            "proliferatorBonusProgress": { "iron_ingot": 0.8 },
            "mod:unknown": {
                "signedZero": -0.0,
                "nested": { "keep": [1, 2, 3] }
            }
        })
    }

    fn fixture_state_from_base_with_registry(
        base: Value,
        entities: &[Value],
        registry_fingerprint: &str,
    ) -> CoreState {
        fixture_state_from_base_belts_with_registry(base, entities, &[], registry_fingerprint)
    }

    fn fixture_state_from_base_belts_with_registry(
        base: Value,
        entities: &[Value],
        belts: &[Value],
        registry_fingerprint: &str,
    ) -> CoreState {
        fixture_state_from_base_belts_with_catalog(
            base,
            entities,
            belts,
            registry_fingerprint,
            fixture_catalog_with_registry(registry_fingerprint),
        )
    }

    fn fixture_state_from_base_belts_with_catalog(
        base: Value,
        entities: &[Value],
        belts: &[Value],
        registry_fingerprint: &str,
        catalog: RuntimeCatalog,
    ) -> CoreState {
        let state_mode = base
            .get("mode")
            .and_then(Value::as_str)
            .unwrap_or("normal")
            .to_owned();
        let entity_count = entities.len();
        let belt_count = belts.len();
        let base = serde_json::to_vec(&base).unwrap();
        let entities = serde_json::to_vec(entities).unwrap();
        let belts = serde_json::to_vec(belts).unwrap();
        let chunks = [
            ("base", "base", &base, 0, 1),
            ("entities:00000000", "entities", &entities, 0, entity_count),
            ("belts:00000000", "belts", &belts, 0, belt_count),
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
            "mode": state_mode,
            "slot": "main",
            "stateVersion": 47,
            "savedAt": 1,
            "basePrimaryChecksum": "12345678",
            "chunkRootChecksum": "12345678",
            "totalBytes": base.len() + entities.len() + belts.len(),
            "entityCount": entity_count,
            "beltCount": belt_count,
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
                slot: format!("{}-main", state_mode),
                generation: 1,
                root_hash: "a".repeat(64),
                revision: 7,
                state_version: 47,
                mode: state_mode,
                registry_fingerprint: registry_fingerprint.to_owned(),
                base_primary_checksum: "12345678".to_owned(),
            },
            &records,
            catalog,
        )
        .unwrap()
    }

    pub(crate) fn fixture_state_from_base(base: Value, entities: &[Value]) -> CoreState {
        fixture_state_from_base_with_registry(base, entities, "machine-e3")
    }

    pub(crate) fn fixture_state(entities: &[Value]) -> CoreState {
        fixture_state_from_base(fixture_base(), entities)
    }

    pub(crate) fn construction_isolation_base() -> Value {
        const SYSTEM_IDS: [&str; 8] = [
            "helios",
            "borealis",
            "aurora",
            "ember",
            "sirius",
            "white_dwarf",
            "neutron",
            "blue_giant",
        ];
        let mut plans = Map::new();
        let mut active_orbits = Map::new();
        let mut orbits = Map::new();
        let mut absorption = Map::new();
        let mut system_profiles = Map::new();
        for system_id in SYSTEM_IDS {
            let orbit_id = format!("test-orbit-{system_id}");
            plans.insert(
                system_id.to_owned(),
                json!({
                    "systemId": system_id,
                    "activeLayerId": null,
                    "structurePoints": 0,
                    "shellSails": 0,
                    "layers": []
                }),
            );
            active_orbits.insert(system_id.to_owned(), Value::from(orbit_id.clone()));
            orbits.insert(
                system_id.to_owned(),
                json!([{
                    "id": orbit_id,
                    "name": "test",
                    "radius": 12000,
                    "inclination": 0,
                    "longitude": 0,
                    "sailsInOrbit": 0,
                    "totalLaunched": 0,
                    "totalExpired": 0,
                    "decayProgress": 0,
                    "generationKw": 0
                }]),
            );
            absorption.insert(system_id.to_owned(), Value::from(0));
            system_profiles.insert(system_id.to_owned(), json!({ "luminosity": 1 }));
        }

        let mut base = Map::new();
        for (key, value) in [
            ("version", json!(47)),
            ("mode", json!("normal")),
            ("activePlanetId", json!("home")),
            ("elapsedSeconds", json!(0)),
            ("historyRecordedAt", json!(0)),
            ("productionHistory", json!([])),
            ("paused", json!(false)),
            ("tray", json!({ "iron_ore": 10 })),
            ("planetTrays", json!({ "home": { "iron_ore": 10 } })),
            ("planetTrayItemLimits", json!({ "home": 1000000 })),
            (
                "portableFleet",
                json!({ "logistics_drone": 0, "logistics_vessel": 0 }),
            ),
            ("construction", json!({ "test_building": 0 })),
            ("manualMined", json!(0)),
            ("totalProduced", json!({})),
            ("blueprints", json!([])),
            ("handcraftQueue", json!([])),
            ("constructionQueue", json!([])),
            ("planetMetrics", json!({ "home": {} })),
            ("powerGridMetrics", json!({ "home": {} })),
            ("systemSpaceStations", json!({})),
        ] {
            base.insert(key.to_owned(), value);
        }
        base.insert(
            "settings".to_owned(),
            json!({
                "simulationSpeed": 1,
                "resourceMode": "infinite",
                "difficulty": "standard",
                "productionBufferLimit": 1000000,
                "logisticsBufferLimit": 1000000,
                "beltBufferLimit": 100000000,
                "proliferatorBufferLimit": 600
            }),
        );
        base.insert(
            "research".to_owned(),
            json!({
                "selectedTechId": null,
                "pausedTechId": null,
                "queuedTechIds": [],
                "progressByTech": {},
                "completedTechIds": ["proliferator_1"]
            }),
        );
        base.insert(
            "campaign".to_owned(),
            json!({
                "completedTaskIds": [],
                "rewardedTaskIds": [],
                "activeTaskId": "mine_first_ore",
                "activeChapterId": "foundation"
            }),
        );
        base.insert(
            "constructionAutomation".to_owned(),
            json!({
                "enabled": true,
                "targetStock": { "test_building": 1 },
                "cursor": 0,
                "totalCrafted": 0,
                "lastCraftedId": null,
                "destroyedByproducts": {},
                "jobs": {},
                "quantumSourceEnabled": false,
                "quantumMaterialBuffer": {}
            }),
        );
        base.insert(
            "exploration".to_owned(),
            json!({
                "missions": [],
                "unlockedSystemIds": ["helios"],
                "colonizedPlanetIds": ["home"],
                "surveyProgressBySystem": { "helios": 1 }
            }),
        );
        base.insert(
            "galaxy".to_owned(),
            json!({
                "profiles": {
                    "home": {
                        "windMultiplier": 1,
                        "solarMultiplier": 1,
                        "geothermalMultiplier": 1,
                        "miningMultiplier": 1,
                        "productionSpeedMultiplier": 1,
                        "specialization": "balanced",
                        "oceanType": "none"
                    }
                },
                "systemProfiles": Value::Object(system_profiles)
            }),
        );
        base.insert(
            "timeWarp".to_owned(),
            json!({
                "controllerEntityId": null,
                "enabled": false,
                "requestedMultiplier": 1,
                "effectiveMultiplier": 1,
                "pendingSimulationSeconds": 0,
                "pendingWallSeconds": 0,
                "requiredPowerKw": 0,
                "allocatedPowerKw": 0
            }),
        );
        base.insert(
            "dysonSwarm".to_owned(),
            json!({
                "sailsInOrbit": 0,
                "totalLaunched": 0,
                "totalExpired": 0,
                "decayProgress": 0,
                "generationKw": 0,
                "receiverLoadKw": 0
            }),
        );
        base.insert(
            "dysonSphere".to_owned(),
            json!({
                "structurePoints": 0,
                "totalRocketsLaunched": 0,
                "shellSails": 0,
                "totalSailsAbsorbed": 0,
                "absorptionProgress": 0,
                "generationKw": 0
            }),
        );
        base.insert(
            "dysonEngineering".to_owned(),
            json!({
                "launchMode": "balanced",
                "launchThrottle": 1,
                "launchEnabled": false,
                "activeOrbitBySystem": Value::Object(active_orbits),
                "orbitsBySystem": Value::Object(orbits),
                "absorptionProgressBySystem": Value::Object(absorption),
                "launchEnergySpentMj": 0
            }),
        );
        base.insert("dysonPlans".to_owned(), Value::Object(plans));
        base.insert(
            "galacticHubNetwork".to_owned(),
            json!({
                "fleetInstalled": 0,
                "fleetBusy": 0,
                "fleetReturns": [],
                "warpers": "0",
                "warperTarget": "0",
                "routingCursors": {}
            }),
        );
        base.insert(
            "quantumLogisticsNetwork".to_owned(),
            json!({
                "enabled": false,
                "inventory": {},
                "itemCapacities": {},
                "routingCursors": {},
                "uploadRoutingCursors": {}
            }),
        );
        base.insert(
            "endgame".to_owned(),
            json!({
                "activeInfiniteResearchId": null,
                "autoResearch": false,
                "autoDispatch": false,
                "dispatchThrottle": 1,
                "exportInputMode": "building",
                "exportProjects": {
                    "universe_archive": { "enabled": false, "priority": 1, "level": 0, "delivered": 0, "totalDelivered": 0, "dispatchProgress": 0 },
                    "solar_sail_array": { "enabled": false, "priority": 1, "level": 0, "delivered": 0, "totalDelivered": 0, "dispatchProgress": 0 },
                    "carrier_rocket_fleet": { "enabled": false, "priority": 1, "level": 0, "delivered": 0, "totalDelivered": 0, "dispatchProgress": 0 },
                    "antimatter_exchange": { "enabled": false, "priority": 1, "level": 0, "delivered": 0, "totalDelivered": 0, "dispatchProgress": 0 }
                },
                "galacticCredits": 0,
                "galacticScore": 0,
                "totalExported": 0,
                "exportedLastMinute": 0,
                "exportWindowAmount": 0,
                "exportWindowStartedAt": 0,
                "infiniteResearch": {
                    "matrix_compression": { "level": 0, "progress": "0" },
                    "vein_utilization": { "level": 0, "progress": "0" },
                    "galactic_logistics": { "level": 0, "progress": "0" },
                    "stellar_harnessing": { "level": 0, "progress": "0" },
                    "continuum_simulation": { "level": 0, "progress": "0" }
                },
                "constructionActivity": { "activityId": null, "activityClockMs": 0 }
            }),
        );
        Value::Object(base)
    }

    fn construction_isolation_fixture() -> CoreState {
        fixture_state_from_base(
            construction_isolation_base(),
            &[
                json!({
                    "id": "wind",
                    "kind": "power",
                    "planetId": "home",
                    "powerGridId": "grid-a",
                    "buildingId": "wind_turbine",
                    "machineCount": 1,
                    "minerCount": 0,
                    "inputs": {},
                    "outputs": {},
                    "progress": 0,
                    "routingCursor": 0,
                    "utilization": 0,
                    "productionRate": 0
                }),
                json!({
                    "id": "smelter",
                    "kind": "machine",
                    "planetId": "home",
                    "powerGridId": "grid-a",
                    "buildingId": "arc_smelter",
                    "recipeId": "iron_ingot",
                    "machineCount": 300,
                    "minerCount": 0,
                    "inputs": { "iron_ore": 10000 },
                    "outputs": { "iron_ingot": 0 },
                    "progress": 0,
                    "routingCursor": 0,
                    "utilization": 0,
                    "productionRate": 0
                }),
                json!({
                    "id": "construction-center",
                    "kind": "machine",
                    "planetId": "home",
                    "powerGridId": "grid-a",
                    "buildingId": "construction_center",
                    "machineCount": 1,
                    "minerCount": 0,
                    "inputs": {},
                    "outputs": {},
                    "progress": 0,
                    "routingCursor": 0,
                    "utilization": 0,
                    "productionRate": 0
                }),
            ],
        )
    }

    fn partitioned_factory_fixture() -> CoreState {
        let machine_count = PARALLEL_MIN_ITEMS + 73;
        let vein_count = 97;
        let mut entities = Vec::with_capacity(machine_count + vein_count + 3);
        entities.push(json!({
            "id": "partitioned-wind",
            "kind": "power",
            "planetId": "home",
            "powerGridId": "grid-a",
            "buildingId": "wind_turbine",
            "machineCount": 1,
            "minerCount": 0,
            "inputs": {},
            "outputs": {},
            "progress": 0,
            "routingCursor": 0,
            "utilization": 0,
            "productionRate": 0
        }));
        entities.extend((0..machine_count).map(|index| {
            machine_entity(
                format!("partitioned-machine-{index:05}"),
                "arc_smelter",
                "iron_ingot",
            )
        }));
        entities.extend((0..vein_count).map(|index| {
            let mut vein = vein_entity(index);
            vein["id"] = Value::from(format!("partitioned-vein-{index:05}"));
            vein
        }));
        entities.push(json!({
            "id": "partitioned-construction-center",
            "kind": "machine",
            "planetId": "home",
            "powerGridId": "grid-a",
            "buildingId": "construction_center",
            "machineCount": 1,
            "minerCount": 0,
            "inputs": {},
            "outputs": {},
            "progress": 0,
            "routingCursor": 0,
            "utilization": 0,
            "productionRate": 0
        }));
        fixture_state_from_base(construction_isolation_base(), &entities)
    }

    fn construction_exact_request(base_revision: u64) -> CoreAdvanceRequest {
        CoreAdvanceRequest {
            base_revision,
            simulation_seconds: 5.1,
            wall_seconds: 5.1,
            advance_mode: CoreAdvanceMode::Exact,
            include_diagnostics: false,
        }
    }

    #[test]
    fn quantum_oactive_profile_is_single_response_bound_and_state_neutral_at_1_5_60_seconds() {
        for (request_id, seconds) in [(101_u64, 1.0), (105, 5.0), (160, 60.0)] {
            let source = construction_isolation_fixture();
            let mut ordinary = source.clone();
            let mut profiled = source;
            let base_revision = ordinary.revision;
            let request = CoreAdvanceRequest {
                base_revision,
                simulation_seconds: seconds,
                wall_seconds: seconds,
                advance_mode: CoreAdvanceMode::Exact,
                include_diagnostics: false,
            };
            let ordinary_result = ordinary.advance(&request).expect("ordinary exact advance");
            let session_id = format!("quantum-oactive-{seconds}");
            let binding = crate::profile_evidence::ProfileOperationBinding::new(
                request_id,
                &session_id,
                base_revision,
                crate::profile_evidence::ProfileOperationPurpose::QuantumOactiveShapeV1,
            )
            .expect("profile binding");
            let capture = crate::profile_evidence::with_profile_operation_binding(binding, || {
                profiled.advance(&request)
            });
            let profiled_result = capture.result.expect("profiled exact advance");

            assert!(!capture.overflowed, "{seconds}s");
            assert_eq!(capture.records.len(), 1, "{seconds}s");
            assert_eq!(
                profiled_result.revision, ordinary_result.revision,
                "{seconds}s"
            );
            assert_eq!(
                profiled.canonical_sha256().unwrap(),
                ordinary.canonical_sha256().unwrap(),
                "canonical hash at {seconds}s"
            );
            assert_eq!(
                profiled.domain_sha256().unwrap(),
                ordinary.domain_sha256().unwrap(),
                "domain hash at {seconds}s"
            );
            assert_eq!(
                profiled.materialize().unwrap(),
                ordinary.materialize().unwrap(),
                "materialized state at {seconds}s"
            );
            let evidence = capture.records.first().expect("one profile record");
            assert_eq!(evidence["recordType"], "quantum-oactive-shape");
            assert_eq!(evidence["operationBinding"]["requestId"], request_id);
            assert_eq!(
                evidence["operationBinding"]["sessionIdSha256"],
                hex::encode(<sha2::Sha256 as sha2::Digest>::digest(
                    session_id.as_bytes()
                ))
            );
            assert_eq!(evidence["operationBinding"]["baseRevision"], base_revision);
            assert_eq!(
                evidence["operationBinding"]["expectedMeasuredRevision"],
                ordinary_result.revision
            );
            assert_eq!(
                evidence["operationBinding"]["profilePurpose"],
                "quantum-oactive-shape-v1"
            );
            assert!(
                evidence["activeScanCalls"]
                    .as_u64()
                    .is_some_and(|calls| calls >= seconds as u64),
                "{seconds}s"
            );
            assert!(
                evidence["perItemFanout"]
                    .as_array()
                    .is_some_and(|rows| rows.len() <= 64)
            );
        }
    }

    #[test]
    fn exact_construction_isolation_keeps_power_and_ordinary_production_conservative() {
        let initial = construction_isolation_fixture();
        let mut default_exact = initial.clone();
        let mut direct_default_exact = initial.clone();
        let mut isolated_exact = initial;

        let default_revision = default_exact.revision;
        let default_result = default_exact
            .advance(&construction_exact_request(default_revision))
            .unwrap();
        assert!(
            default_result.supported,
            "unexpected default exact reason: {:?}",
            default_result.reason
        );
        let direct_revision = direct_default_exact.revision;
        let direct_result = direct_default_exact
            .advance_exact(&construction_exact_request(direct_revision))
            .unwrap();
        assert!(
            direct_result.supported,
            "unexpected direct default exact reason: {:?}",
            direct_result.reason
        );
        assert_eq!(
            default_exact.canonical_sha256().unwrap(),
            direct_default_exact.canonical_sha256().unwrap(),
            "the public exact dispatch and the default crate exact path must remain hash-identical"
        );
        assert_eq!(
            default_exact.materialize().unwrap(),
            direct_default_exact.materialize().unwrap()
        );
        let isolated_revision = isolated_exact.revision;
        let isolated_result = isolated_exact
            .advance_exact_isolating_construction(&construction_exact_request(isolated_revision))
            .unwrap();
        assert!(
            isolated_result.supported,
            "unexpected isolated exact reason: {:?}",
            isolated_result.reason
        );

        assert_eq!(
            default_exact.base_value()["construction"]["test_building"],
            json!(1.0)
        );
        assert_eq!(default_exact.base_value()["tray"]["iron_ore"], json!(9.0));
        assert_eq!(
            default_exact.base_value()["constructionAutomation"]["totalCrafted"],
            json!(1.0)
        );
        assert_eq!(
            isolated_exact.base_value()["construction"]["test_building"],
            json!(0)
        );
        assert_eq!(isolated_exact.base_value()["tray"]["iron_ore"], json!(10));
        assert_eq!(
            isolated_exact.base_value()["constructionAutomation"]["totalCrafted"],
            json!(0)
        );
        assert_eq!(
            isolated_exact.base_value()["constructionAutomation"]["jobs"],
            json!({})
        );

        let default_entities = default_exact.parse_entities_parallel().unwrap();
        let isolated_entities = isolated_exact.parse_entities_parallel().unwrap();
        let default_smelter = default_entities
            .iter()
            .find(|entity| entity["id"] == "smelter")
            .unwrap();
        let isolated_smelter = isolated_entities
            .iter()
            .find(|entity| entity["id"] == "smelter")
            .unwrap();
        assert_eq!(default_smelter, isolated_smelter);
        assert!(
            isolated_smelter["outputs"]["iron_ingot"]
                .as_f64()
                .is_some_and(|amount| amount > 0.0 && amount < 1_530.0),
            "ordinary production must run under the construction-inclusive power factor"
        );
        assert_eq!(
            default_exact.base_value()["totalProduced"]["iron_ingot"],
            isolated_exact.base_value()["totalProduced"]["iron_ingot"]
        );
        assert_eq!(
            default_exact.base_value()["powerGridMetrics"],
            isolated_exact.base_value()["powerGridMetrics"]
        );
        for key in ["generationKw", "demandKw", "powerFactor"] {
            assert_eq!(
                default_exact.base_value()["planetMetrics"]["home"][key],
                isolated_exact.base_value()["planetMetrics"]["home"][key]
            );
        }
        let isolated_grid = &isolated_exact.base_value()["powerGridMetrics"]["home"]["grid-a"];
        assert_eq!(isolated_grid["generationKw"], json!(300.0));
        assert_eq!(isolated_grid["demandKw"], json!(301.0));
        assert_eq!(isolated_grid["powerFactor"], json!(0.9967));
    }

    #[test]
    fn failed_isolated_exact_candidate_leaves_source_transaction_unchanged() {
        let mut source = construction_isolation_fixture();
        source.base_value_mut().remove("totalProduced");
        let revision = source.revision;
        let hash = source.canonical_sha256().unwrap();
        let bytes = source.materialize().unwrap();

        let failure = source
            .advance_exact_isolating_construction(&construction_exact_request(revision))
            .unwrap_err();
        assert!(
            format!("{failure:#}").contains("total production record is missing"),
            "unexpected failure: {failure:#}"
        );
        assert_eq!(source.revision, revision);
        assert_eq!(source.canonical_sha256().unwrap(), hash);
        assert_eq!(source.materialize().unwrap(), bytes);
        assert_eq!(
            source.base_value()["construction"]["test_building"],
            json!(0)
        );
        assert_eq!(source.base_value()["tray"]["iron_ore"], json!(10));
    }

    fn assert_prepared_factory_domains_are_clear(state: &CoreState) {
        assert!(state.prepared_belt_routes().is_none());
        assert!(state.prepared_logistics_buffer_runtime().is_none());
        assert!(state.prepared_material_delivery_runtime().is_none());
        assert!(state.prepared_ordinary_production_runtime().is_none());
        assert!(state.prepared_planet_metrics_runtime().is_none());
        assert!(state.prepared_power_probe_runtime().is_none());
        assert!(state.prepared_local_peer_directory().is_none());
        assert!(state.prepared_quantum_logistics_directory().is_none());
        assert!(state.prepared_construction_runtime().is_none());
        assert!(state.prepared_station_mode_transition_runtime().is_none());
        assert!(state.prepared_quantum_transition_runtime().is_none());
        assert!(state.prepared_interstellar_peer_directory().is_none());
        assert!(state.prepared_interstellar_route_activity().is_none());
    }

    fn synthetic_conservation_sha256(state: &CoreState) -> String {
        let materialized = state.materialize().unwrap();
        let object = materialized.as_object().unwrap();
        let mut projection = Map::new();
        for key in [
            "tray",
            "planetTrays",
            "quantumInventory",
            "totalProduced",
            "manualMined",
            "galacticExports",
            "constructionQueue",
            "constructionProjects",
            "dysonSphere",
            "dysonSwarm",
            "entities",
            "belts",
        ] {
            if let Some(value) = object.get(key) {
                projection.insert(key.to_owned(), value.clone());
            }
        }
        crate::canonical::canonical_sha256(&Value::Object(projection))
    }

    fn ordinary_oactive_machine(index: usize, input: f64, output: f64) -> Value {
        json!({
            "id": format!("ordinary-oactive-machine-{index:05}"),
            "kind": "machine",
            "planetId": "home",
            "powerGridId": "grid-a",
            "buildingId": "arc_smelter",
            "recipeId": "iron_ingot",
            "machineCount": 1,
            "minerCount": 0,
            "inputs": { "iron_ore": input },
            "outputs": { "iron_ingot": output },
            "progress": 0,
            "utilization": 0,
            "productionRate": 0,
            "routingCursor": 0,
            "proliferatorBonusProgress": { "iron_ingot": 0 }
        })
    }

    fn ordinary_oactive_vein(id: &str, miner_count: f64, output: f64, remaining: f64) -> Value {
        json!({
            "id": id,
            "kind": "vein",
            "planetId": "home",
            "powerGridId": "grid-a",
            "buildingId": "mining_machine",
            "recipeId": null,
            "machineCount": 1,
            "minerCount": miner_count,
            "resourceId": "iron_ore",
            "resourceRemaining": remaining,
            "resourceDepletionRemainder": 0,
            "outputs": { "iron_ore": output },
            "progress": 0,
            "utilization": 0,
            "productionRate": 0
        })
    }

    fn research_boundary_lab(id: &str, universe_matrix: f64) -> Value {
        json!({
            "id": id,
            "kind": "machine",
            "planetId": "home",
            "powerGridId": "grid-a",
            "buildingId": "matrix_lab",
            "recipeId": "matrix_research",
            "machineCount": 1,
            "minerCount": 0,
            "inputs": { "universe_matrix": universe_matrix },
            "outputs": {},
            "progress": 0,
            "utilization": 0,
            "productionRate": 0,
            "routingCursor": 0,
            "proliferatorBonusProgress": {}
        })
    }

    fn research_boundary_fixture(
        ordinary_count: usize,
        universe_matrix: f64,
        finite_progress: f64,
    ) -> CoreState {
        let mut base = construction_isolation_base();
        base["research"]["selectedTechId"] = Value::from("research_speed_1");
        base["research"]["progressByTech"] = json!({
            "research_speed_1": { "universe_matrix": finite_progress }
        });
        let mut entities = Vec::with_capacity(ordinary_count + 2);
        entities.push(json!({
            "id": "research-boundary-wind",
            "kind": "power",
            "planetId": "home",
            "powerGridId": "grid-a",
            "buildingId": "wind_turbine",
            "machineCount": 1,
            "minerCount": 0,
            "inputs": {},
            "outputs": {},
            "progress": 0,
            "utilization": 0,
            "productionRate": 0,
            "routingCursor": 0
        }));
        // Keep the barrier ahead of the ordinary rows so a boundary-capable
        // test also proves that later rows retain their historical multiplier.
        entities.push(research_boundary_lab(
            "research-boundary-lab",
            universe_matrix,
        ));
        entities.extend((0..ordinary_count).map(|index| {
            ordinary_oactive_machine(
                50_000 + index,
                if index == 0 { 100.0 } else { 0.0 },
                if index == 1 { 100.0 } else { 0.0 },
            )
        }));
        fixture_state_from_base_with_registry(
            base,
            &entities,
            crate::command::EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT,
        )
    }

    fn infinite_research_boundary_fixture(
        ordinary_count: usize,
        universe_matrix: f64,
        level: u32,
        progress: &str,
        auto_research: bool,
    ) -> CoreState {
        let mut state = research_boundary_fixture(ordinary_count, universe_matrix, 0.0);
        state.base_value_mut()["research"]["selectedTechId"] = Value::Null;
        state.base_value_mut()["research"]["completedTechIds"] =
            json!(["proliferator_1", "universe_matrix"]);
        state.base_value_mut()["endgame"]["activeInfiniteResearchId"] =
            Value::from("matrix_compression");
        state.base_value_mut()["endgame"]["autoResearch"] = Value::from(auto_research);
        state.base_value_mut()["endgame"]["infiniteResearch"]["matrix_compression"] = json!({
            "level": level,
            "progress": progress
        });
        state
    }

    fn ordinary_belt_wake_fixture() -> CoreState {
        let base = construction_isolation_base();
        let mut producer = ordinary_oactive_machine(90_000, 100.0, 100.0);
        producer["id"] = Value::from("belt-wake-producer");
        let storage = |id: &str, input: f64, output: f64| {
            json!({
                "id": id,
                "kind": "storage",
                "planetId": "home",
                "powerGridId": "grid-a",
                "buildingId": "storage_mk1",
                "recipeId": null,
                "storedItemId": "iron_ingot",
                "machineCount": 1,
                "minerCount": 0,
                "inputs": { "iron_ingot": input },
                "outputs": { "iron_ingot": output },
                "progress": 0,
                "utilization": 0,
                "productionRate": 0,
                "routingCursor": 0
            })
        };
        let mut entities = vec![
            json!({
                "id": "belt-wake-wind",
                "kind": "power",
                "planetId": "home",
                "powerGridId": "grid-a",
                "buildingId": "wind_turbine",
                "machineCount": 1,
                "minerCount": 0,
                "inputs": {},
                "outputs": {},
                "progress": 0,
                "utilization": 0,
                "productionRate": 0,
                "routingCursor": 0
            }),
            producer,
            storage("belt-wake-buffer", 100.0, 100.0),
            storage("belt-wake-sink", 0.0, 0.0),
        ];
        entities.extend((0..32).map(|index| ordinary_oactive_machine(91_000 + index, 0.0, 0.0)));
        let belts = vec![
            json!({
                "id": "belt-wake-producer-to-buffer",
                "planetId": "home",
                "source": "belt-wake-producer",
                "target": "belt-wake-buffer",
                "itemId": "iron_ingot",
                "lanes": 1,
                "stackSize": 1,
                "tier": 1,
                "priority": 1,
                "progress": 0,
                "totalTransferred": 0,
                "lastFlow": 0,
                "congestion": 0
            }),
            json!({
                "id": "belt-wake-buffer-to-sink",
                "planetId": "home",
                "source": "belt-wake-buffer",
                "target": "belt-wake-sink",
                "itemId": "iron_ingot",
                "lanes": 1,
                "stackSize": 1,
                "tier": 1,
                "priority": 1,
                "progress": 0,
                "totalTransferred": 0,
                "lastFlow": 0,
                "congestion": 0
            }),
        ];
        fixture_state_from_base_belts_with_registry(
            base,
            &entities,
            &belts,
            crate::command::EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT,
        )
    }

    fn material_delivery_hub(index: usize) -> Value {
        json!({
            "id": format!("material-delivery-hub-{index:05}"),
            "kind": "storage",
            "planetId": "home",
            "powerGridId": "grid-a",
            "buildingId": "material_delivery_hub",
            "recipeId": null,
            "machineCount": 1,
            "minerCount": 0,
            "deliveryItemIds": ["iron_ingot"],
            "deliverySlots": [
                { "itemId": "iron_ingot", "mode": "manual" },
                { "itemId": null, "mode": "auto" },
                { "itemId": null, "mode": "disabled" }
            ],
            "inputs": { "iron_ingot": 0 },
            "outputs": {},
            "progress": 0.75,
            "utilization": 0.5,
            "productionRate": 12.5,
            "routingCursor": 0
        })
    }

    fn material_delivery_oactive_fixture(hub_count: usize) -> CoreState {
        material_delivery_belt_fixture(hub_count, true, false)
    }

    fn material_delivery_output_belt_fixture(hub_count: usize) -> CoreState {
        material_delivery_belt_fixture(hub_count, false, true)
    }

    fn material_delivery_sparse_output_belt_fixture(stable_row_count: usize) -> CoreState {
        let seed = material_delivery_output_belt_fixture(1);
        let Value::Object(mut base) = seed.materialize().unwrap() else {
            panic!("material-delivery fixture must materialize to an object");
        };
        let mut entities = base
            .remove("entities")
            .and_then(|value| value.as_array().cloned())
            .unwrap();
        let belts = base
            .remove("belts")
            .and_then(|value| value.as_array().cloned())
            .unwrap();
        entities.extend((0..stable_row_count).map(|index| {
            json!({
                "id": format!("material-delivery-stable-{index:05}"),
                "kind": "storage",
                "planetId": "home",
                "powerGridId": "grid-a",
                "buildingId": "storage_mk1",
                "recipeId": null,
                "storedItemId": "iron_ore",
                "machineCount": 1,
                "minerCount": 0,
                "inputs": {},
                "outputs": {},
                "progress": 0,
                "utilization": 0,
                "productionRate": 0,
                "routingCursor": 0
            })
        }));
        fixture_state_from_base_belts_with_registry(
            Value::Object(base),
            &entities,
            &belts,
            crate::command::EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT,
        )
    }

    fn material_delivery_segment_fixture(hub_count: usize) -> CoreState {
        let mut base = construction_isolation_base();
        base["tray"]["iron_ingot"] = Value::from(0);
        base["planetTrays"]["home"]["iron_ingot"] = Value::from(0);
        let mut entities = vec![json!({
            "id": "material-delivery-segment-wind",
            "kind": "power",
            "planetId": "home",
            "powerGridId": "grid-a",
            "buildingId": "wind_turbine",
            "machineCount": 1,
            "minerCount": 0,
            "inputs": {},
            "outputs": {},
            "progress": 0,
            "utilization": 0,
            "productionRate": 0,
            "routingCursor": 0
        })];
        entities.extend((0..hub_count).map(material_delivery_hub));
        fixture_state_from_base_with_registry(
            base,
            &entities,
            crate::command::EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT,
        )
    }

    fn material_delivery_belt_fixture(
        hub_count: usize,
        include_input_belts: bool,
        include_output_belt: bool,
    ) -> CoreState {
        let mut base = construction_isolation_base();
        base["tray"]["iron_ingot"] = Value::from(0);
        base["planetTrays"]["home"]["iron_ingot"] = Value::from(0);
        let mut feeder = ordinary_oactive_machine(96_000, 100.0, 0.0);
        feeder["id"] = Value::from("material-delivery-feeder");
        let relay = json!({
            "id": "material-delivery-relay",
            "kind": "storage",
            "planetId": "home",
            "powerGridId": "grid-a",
            "buildingId": "storage_mk1",
            "recipeId": null,
            "storedItemId": "iron_ingot",
            "machineCount": 1,
            "minerCount": 0,
            "inputs": { "iron_ingot": 0 },
            "outputs": { "iron_ingot": 0 },
            "progress": 0,
            "utilization": 0,
            "productionRate": 0,
            "routingCursor": 0
        });
        let mut direct = ordinary_oactive_machine(96_001, 100.0, 0.0);
        direct["id"] = Value::from("material-delivery-direct");
        let output_sink = json!({
            "id": "material-delivery-output-sink",
            "kind": "storage",
            "planetId": "home",
            "powerGridId": "grid-a",
            "buildingId": "storage_mk1",
            "recipeId": null,
            "storedItemId": "iron_ingot",
            "machineCount": 1,
            "minerCount": 0,
            "inputs": { "iron_ingot": 0 },
            "outputs": { "iron_ingot": 0 },
            "progress": 0,
            "utilization": 0,
            "productionRate": 0,
            "routingCursor": 0
        });
        let mut entities = vec![
            json!({
                "id": "material-delivery-wind",
                "kind": "power",
                "planetId": "home",
                "powerGridId": "grid-a",
                "buildingId": "wind_turbine",
                "machineCount": 1,
                "minerCount": 0,
                "inputs": {},
                "outputs": {},
                "progress": 0,
                "utilization": 0,
                "productionRate": 0,
                "routingCursor": 0
            }),
            feeder,
            relay,
            direct,
            output_sink,
        ];
        entities.extend((0..hub_count).map(material_delivery_hub));
        if include_output_belt {
            let hub = entities
                .iter_mut()
                .find(|entity| entity["id"] == "material-delivery-hub-00000")
                .expect("output hub");
            hub["storedItemId"] = Value::from("iron_ingot");
            hub["outputs"]["iron_ingot"] = Value::from(100);
        }
        let belt = |id: &str, source: &str, target: &str, target_port_index: Option<u8>| {
            let mut belt = json!({
                "id": id,
                "planetId": "home",
                "source": source,
                "target": target,
                "itemId": "iron_ingot",
                "lanes": 1,
                "stackSize": 1,
                "tier": 1,
                "priority": 1,
                "progress": 0,
                "totalTransferred": 0,
                "lastFlow": 0,
                "congestion": 0
            });
            if let Some(target_port_index) = target_port_index {
                belt["targetPortIndex"] = Value::from(target_port_index);
            }
            belt
        };
        let target = "material-delivery-hub-00000";
        let mut belts = Vec::new();
        if include_input_belts {
            belts.extend([
                belt(
                    "material-delivery-relay-to-hub",
                    "material-delivery-relay",
                    target,
                    Some(0),
                ),
                belt(
                    "material-delivery-feeder-to-relay",
                    "material-delivery-feeder",
                    "material-delivery-relay",
                    None,
                ),
                belt(
                    "material-delivery-direct-to-hub",
                    "material-delivery-direct",
                    target,
                    Some(0),
                ),
            ]);
        }
        if include_output_belt {
            belts.push(belt(
                "material-delivery-hub-to-output-sink",
                target,
                "material-delivery-output-sink",
                None,
            ));
        }
        fixture_state_from_base_belts_with_registry(
            base,
            &entities,
            &belts,
            crate::command::EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT,
        )
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    struct MaterialDeliveryOactiveRun {
        bytes: Vec<u8>,
        canonical: String,
        domain: String,
        conservation: String,
        scans: Vec<crate::material_delivery::MaterialDeliveryScan>,
    }

    fn run_material_delivery_oactive_advance(
        seconds: f64,
        worker_count: usize,
        flat_full_control: bool,
    ) -> MaterialDeliveryOactiveRun {
        let mut state = material_delivery_oactive_fixture(1_024);
        let prepared = prepare_advance_with_material_delivery_test_options(
            &state,
            seconds,
            seconds,
            false,
            &DeterministicRuntime::for_test(worker_count),
            if flat_full_control {
                MaterialDeliveryDrainMode::FlatFull
            } else {
                MaterialDeliveryDrainMode::Indexed
            },
            None,
        )
        .unwrap();
        let scans = prepared
            .material_delivery_runtime
            .scan_history_for_test()
            .to_vec();
        state
            .commit_simulated_state(
                prepared.base,
                prepared.entities,
                prepared.belt_commit,
                state.revision + 1,
                false,
            )
            .unwrap();
        MaterialDeliveryOactiveRun {
            bytes: serde_json::to_vec(&state.materialize().unwrap()).unwrap(),
            canonical: state.canonical_sha256().unwrap(),
            domain: state.domain_sha256().unwrap(),
            conservation: synthetic_conservation_sha256(&state),
            scans,
        }
    }

    fn commit_and_install_factory_test_state(
        state: &mut CoreState,
        prepared: PreparedFactoryAdvance,
    ) {
        let belt_routes = prepared.belt_routes.clone();
        let belt_activity = prepared.belt_activity.clone();
        let logistics_buffer_runtime = prepared.logistics_buffer_runtime.clone();
        let material_delivery_runtime = prepared.material_delivery_runtime.clone();
        let ordinary_production_runtime = prepared.ordinary_production_runtime.clone();
        let planet_metrics_runtime = prepared.planet_metrics_runtime.clone();
        let power_probe_runtime = prepared.power_probe_runtime.clone();
        let local_peer_directory = prepared.local_peer_directory.clone();
        let quantum_logistics_directory = prepared.quantum_logistics_directory.clone();
        let construction_runtime = prepared.construction_runtime.clone();
        let station_mode_transition_runtime = prepared.station_mode_transition_runtime.clone();
        let quantum_transition_runtime = prepared.quantum_transition_runtime.clone();
        let interstellar_peer_directory = prepared.interstellar_peer_directory.clone();
        let interstellar_route_activity = prepared.interstellar_route_activity.clone();
        let factory_execution_diagnostics = prepared.factory_execution_diagnostics.clone();
        let next_revision = state.revision + 1;
        state
            .commit_simulated_state(
                prepared.base,
                prepared.entities,
                prepared.belt_commit,
                next_revision,
                false,
            )
            .unwrap();
        state.install_prepared_belt_routes(belt_routes);
        state.install_prepared_belt_activity(belt_activity);
        state.install_prepared_logistics_buffer_runtime(logistics_buffer_runtime);
        state.install_prepared_material_delivery_runtime(material_delivery_runtime);
        state.install_prepared_ordinary_production_runtime(ordinary_production_runtime);
        state.install_prepared_planet_metrics_runtime(planet_metrics_runtime);
        state.install_prepared_power_probe_runtime(power_probe_runtime);
        state.install_prepared_local_peer_directory(local_peer_directory);
        state.install_prepared_quantum_logistics_directory(quantum_logistics_directory);
        state.install_prepared_construction_runtime(construction_runtime);
        state.install_prepared_station_mode_transition_runtime(station_mode_transition_runtime);
        state.install_prepared_quantum_transition_runtime(quantum_transition_runtime);
        state.install_prepared_interstellar_peer_directory(interstellar_peer_directory);
        state.install_prepared_interstellar_route_activity(interstellar_route_activity);
        state
            .install_factory_execution_diagnostics(factory_execution_diagnostics)
            .unwrap();
    }

    fn commit_and_install_exact_factory_test_state(
        state: &mut CoreState,
        mut prepared: PreparedFactoryAdvance,
    ) {
        let belt_routes = prepared.belt_routes.clone();
        let belt_activity = prepared.belt_activity.clone();
        let logistics_buffer_runtime = prepared.logistics_buffer_runtime.clone();
        let material_delivery_runtime = prepared.material_delivery_runtime.clone();
        let ordinary_production_runtime = prepared.ordinary_production_runtime.clone();
        let planet_metrics_runtime = prepared.planet_metrics_runtime.clone();
        let power_probe_runtime = prepared.power_probe_runtime.clone();
        let local_peer_directory = prepared.local_peer_directory.clone();
        let quantum_logistics_directory = prepared.quantum_logistics_directory.clone();
        let construction_runtime = prepared.construction_runtime.clone();
        let station_mode_transition_runtime = prepared.station_mode_transition_runtime.clone();
        let quantum_transition_runtime = prepared.quantum_transition_runtime.clone();
        let interstellar_peer_directory = prepared.interstellar_peer_directory.clone();
        let interstellar_route_activity = prepared.interstellar_route_activity.clone();
        let factory_execution_diagnostics = prepared.factory_execution_diagnostics.clone();
        let next_revision = state.revision + 1;
        let campaign_metric_writer_indices = prepared.campaign_metric_writer_indices.take();
        let campaign_projection_update =
            state.campaign_projection_runtime.prepare_simulation_update(
                state,
                &prepared.entities,
                campaign_metric_writer_indices.as_deref(),
                next_revision,
            );
        let cached_campaign_factory_metrics =
            crate::campaign::factory_metrics_needed(&prepared.base)
                .then(|| campaign_projection_update.factory_metrics(state))
                .flatten();
        let sampled_campaign_factory_metrics = state
            .record_production_history_with_campaign_metrics(
                &mut prepared.base,
                &prepared.entities,
                Some(prepared.belt_flow),
                cached_campaign_factory_metrics.as_ref(),
                Some(&prepared.writer_events),
            )
            .unwrap();
        if let Some(production_history_tiers) = prepared.production_history_tiers.as_mut() {
            production_history_tiers.refresh_after_internal_sample(&prepared.base);
        }
        crate::campaign::synchronize_with_factory_metrics(
            state,
            &mut prepared.base,
            &prepared.entities,
            cached_campaign_factory_metrics.or(sampled_campaign_factory_metrics),
        )
        .unwrap();
        crate::campaign::synchronize_orbital_station_eligibility(&mut prepared.base).unwrap();
        crate::speedrun::evaluate(state, &mut prepared.base).unwrap();
        state
            .commit_simulated_state_with_campaign_projection_update_and_history(
                prepared.base,
                prepared.entities,
                prepared.belt_commit,
                next_revision,
                false,
                crate::state::PreparedSimulationRuntimeUpdates {
                    campaign_projection: campaign_projection_update,
                    production_history_tiers: prepared.production_history_tiers,
                },
            )
            .unwrap();
        state.install_prepared_belt_routes(belt_routes);
        state.install_prepared_belt_activity(belt_activity);
        state.install_prepared_logistics_buffer_runtime(logistics_buffer_runtime);
        state.install_prepared_material_delivery_runtime(material_delivery_runtime);
        state.install_prepared_ordinary_production_runtime(ordinary_production_runtime);
        state.install_prepared_planet_metrics_runtime(planet_metrics_runtime);
        state.install_prepared_power_probe_runtime(power_probe_runtime);
        state.install_prepared_local_peer_directory(local_peer_directory);
        state.install_prepared_quantum_logistics_directory(quantum_logistics_directory);
        state.install_prepared_construction_runtime(construction_runtime);
        state.install_prepared_station_mode_transition_runtime(station_mode_transition_runtime);
        state.install_prepared_quantum_transition_runtime(quantum_transition_runtime);
        state.install_prepared_interstellar_peer_directory(interstellar_peer_directory);
        state.install_prepared_interstellar_route_activity(interstellar_route_activity);
        state
            .install_factory_execution_diagnostics(factory_execution_diagnostics)
            .unwrap();
    }

    fn advance_material_delivery_test_state(
        state: &mut CoreState,
        seconds: f64,
        step_size_override: f64,
    ) {
        let prepared = prepare_advance_with_material_delivery_test_options(
            state,
            seconds,
            seconds,
            false,
            &DeterministicRuntime::for_test(4),
            MaterialDeliveryDrainMode::Indexed,
            Some(step_size_override),
        )
        .unwrap();
        commit_and_install_exact_factory_test_state(state, prepared);
    }

    fn material_delivery_state_fingerprint(state: &CoreState) -> (Vec<u8>, String, String, String) {
        (
            serde_json::to_vec(&state.materialize().unwrap()).unwrap(),
            state.canonical_sha256().unwrap(),
            state.domain_sha256().unwrap(),
            synthetic_conservation_sha256(state),
        )
    }

    fn advance_exact_public_seconds(state: &mut CoreState, seconds: f64) {
        let result = state
            .advance(&CoreAdvanceRequest {
                base_revision: state.revision,
                simulation_seconds: seconds,
                wall_seconds: seconds,
                advance_mode: CoreAdvanceMode::Exact,
                include_diagnostics: false,
            })
            .unwrap();
        assert!(
            result.supported,
            "exact {seconds}s advance was unsupported: {:?}",
            result.reason
        );
    }

    fn production_history_segmentation_fixture() -> CoreState {
        let mut state = ordinary_belt_wake_fixture();
        // Keep this a production-history gate. These three unrelated campaign
        // tasks are already satisfied by the synthetic storage/power/machine
        // topology and otherwise complete in call-boundary order.
        state.base_value_mut()["campaign"]["completedTaskIds"] =
            json!(["smelt_iron", "side_storage", "side_stable_power"]);
        state.base_value_mut()["campaign"]["rewardedTaskIds"] =
            json!(["smelt_iron", "side_storage", "side_stable_power"]);
        state
    }

    fn quiescent_segmentation_fixture() -> CoreState {
        let mut base = construction_isolation_base();
        base["constructionAutomation"]["enabled"] = Value::from(false);
        base["constructionAutomation"]["targetStock"] = json!({});
        base["research"]["completedTechIds"] = json!([]);
        fixture_state_from_base(base, &[])
    }

    fn campaign_reward_consumption_segmentation_fixture() -> CoreState {
        const REGISTRY_FINGERPRINT: &str = "campaign-reward-segmentation";
        let source = construction_isolation_fixture();
        let mut entities = source.parse_entities_parallel().unwrap();
        entities
            .iter_mut()
            .find(|entity| entity["id"] == "wind")
            .unwrap()["machineCount"] = Value::from(2);
        let mut base = construction_isolation_base();
        base["construction"] = json!({ "thermal_power_plant": 0 });
        base["constructionAutomation"]["targetStock"] = json!({ "thermal_power_plant": 2 });
        base["research"]["completedTechIds"] = json!(["proliferator_1", "construction_capacity_2"]);
        base["campaign"] = json!({
            "completedTaskIds": [],
            "rewardedTaskIds": [],
            "activeTaskId": "mine_first_ore",
            "activeChapterId": "foundation"
        });
        let mut snapshot = fixture_catalog_with_registry(REGISTRY_FINGERPRINT).snapshot;
        snapshot.constructions.push(ConstructionDefinition {
            id: "thermal_power_plant".to_owned(),
            output_amount: 1.0,
            automation_order: 1,
            required_tech_id: None,
            costs: vec![ItemAmount {
                item_id: "iron_ore".to_owned(),
                amount: 1.0,
            }],
        });
        let catalog = RuntimeCatalog::validate(snapshot, REGISTRY_FINGERPRINT).unwrap();
        fixture_state_from_base_belts_with_catalog(
            base,
            &entities,
            &[],
            REGISTRY_FINGERPRINT,
            catalog,
        )
    }

    fn orbital_unlock_segmentation_fixture() -> CoreState {
        const REGISTRY_FINGERPRINT: &str = "orbital-unlock-segmentation";
        let mut base = construction_isolation_base();
        base["campaign"]["completedTaskIds"] =
            json!(["smelt_iron", "side_storage", "side_stable_power"]);
        base["campaign"]["rewardedTaskIds"] =
            json!(["smelt_iron", "side_storage", "side_stable_power"]);
        base.as_object_mut().unwrap().insert(
            "orbitalStation".to_owned(),
            json!({
                "status": "locked",
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
            }),
        );
        let mut snapshot = fixture_catalog_with_registry(REGISTRY_FINGERPRINT).snapshot;
        snapshot.buildings.push(BuildingDefinition {
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
        });
        snapshot.recipes.push(fixture_recipe(
            "universe_unlock_fixture",
            "arc_smelter",
            None,
            vec![ItemAmount {
                item_id: "iron_ore".to_owned(),
                amount: 1.0,
            }],
            vec![ItemAmount {
                item_id: "universe_matrix".to_owned(),
                amount: 1.0,
            }],
        ));
        let catalog = RuntimeCatalog::validate(snapshot, REGISTRY_FINGERPRINT).unwrap();
        let entities = vec![
            json!({
                "id": "orbital-unlock-wind",
                "kind": "power",
                "planetId": "home",
                "powerGridId": "grid-a",
                "buildingId": "wind_turbine",
                "machineCount": 10,
                "minerCount": 0,
                "inputs": {},
                "outputs": {},
                "progress": 0,
                "routingCursor": 0,
                "utilization": 0,
                "productionRate": 0
            }),
            json!({
                "id": "universe-unlock-producer",
                "kind": "machine",
                "planetId": "home",
                "powerGridId": "grid-a",
                "buildingId": "arc_smelter",
                "recipeId": "universe_unlock_fixture",
                "machineCount": 1,
                "minerCount": 0,
                "inputs": { "iron_ore": 10 },
                "outputs": { "universe_matrix": 0 },
                "progress": 0,
                "routingCursor": 0,
                "utilization": 0,
                "productionRate": 0,
                "proliferatorBonusProgress": {}
            }),
            json!({
                "id": "orbital-unlock-terminal",
                "kind": "storage",
                "planetId": "home",
                "powerGridId": "grid-a",
                "buildingId": "orbital_cargo_terminal",
                "machineCount": 1,
                "minerCount": 0,
                "inputs": { "iron_ore": 100 },
                "outputs": {},
                "powerFactor": 1,
                "orbitalCargoProgress": 0,
                "routingCursor": 0,
                "orbitalCargoTotalUploaded": "0",
                "orbitalCargoBinding": { "kind": "construction" },
                "orbitalCargoPortItems": ["iron_ore", null, null, null],
                "utilization": 0,
                "productionRate": 0
            }),
        ];
        fixture_state_from_base_belts_with_catalog(
            base,
            &entities,
            &[],
            REGISTRY_FINGERPRINT,
            catalog,
        )
    }

    fn campaign_item_reward_wakes_construction_fixture() -> CoreState {
        const REGISTRY_FINGERPRINT: &str = "campaign-item-construction-wake";
        let source = construction_isolation_fixture();
        let mut entities = source.parse_entities_parallel().unwrap();
        entities
            .iter_mut()
            .find(|entity| entity["id"] == "wind")
            .unwrap()["machineCount"] = Value::from(2);
        let smelter = entities
            .iter_mut()
            .find(|entity| entity["id"] == "smelter")
            .unwrap();
        smelter["sprayCoaterInstalled"] = Value::from(true);
        smelter["proliferatorTier"] = Value::from(1);
        smelter["proliferatorMode"] = Value::from("normal");
        let mut base = construction_isolation_base();
        base["tray"]["proliferator_mk1"] = Value::from(0);
        base["planetTrays"]["home"]["proliferator_mk1"] = Value::from(0);
        base["construction"] = json!({ "spray_reward_building": 0 });
        base["constructionAutomation"]["targetStock"] = json!({ "spray_reward_building": 1 });
        base["campaign"] = json!({
            "completedTaskIds": ["side_stable_power"],
            "rewardedTaskIds": ["side_stable_power"],
            "activeTaskId": "mine_first_ore",
            "activeChapterId": "foundation"
        });
        let mut snapshot = fixture_catalog_with_registry(REGISTRY_FINGERPRINT).snapshot;
        snapshot.constructions.push(ConstructionDefinition {
            id: "spray_reward_building".to_owned(),
            output_amount: 1.0,
            automation_order: 1,
            required_tech_id: None,
            costs: vec![ItemAmount {
                item_id: "proliferator_mk1".to_owned(),
                amount: 1.0,
            }],
        });
        let catalog = RuntimeCatalog::validate(snapshot, REGISTRY_FINGERPRINT).unwrap();
        fixture_state_from_base_belts_with_catalog(
            base,
            &entities,
            &[],
            REGISTRY_FINGERPRINT,
            catalog,
        )
    }

    fn speedrun_research_boundary_fixture() -> CoreState {
        let source = research_boundary_fixture(32, 1.0, 99_999.0);
        let entities = source.parse_entities_parallel().unwrap();
        let mut base = Value::Object(source.base_value().clone());
        base["mode"] = Value::from("speedrun");
        base.as_object_mut().unwrap().insert(
            "speedrun".to_owned(),
            json!({
                "enabled": true,
                "mode": "speedrun",
                "rulesetVersion": "speedrun-v1",
                "seasonId": "season_01",
                "startedAt": 1,
                "elapsedActiveSeconds": 0,
                "baseline": {
                    "completedTechIds": ["mining_speed_1"],
                    "rocketsLaunched": 0,
                    "whiteMatrixProduced": 0
                },
                "milestones": {
                    "all_technologies": { "completed": false },
                    "dyson_rockets_10000": { "completed": false },
                    "white_matrix_1m": { "completed": false }
                },
                "eligible": true,
                "factoryId": "speedrun-boundary-fixture-0001"
            }),
        );
        fixture_state_from_base_belts_with_catalog(
            base,
            &entities,
            &[],
            crate::command::EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT,
            source.catalog.as_ref().clone(),
        )
    }

    fn reload_exact_history_checkpoint(state: &CoreState) -> CoreState {
        let mut records = BTreeMap::<String, Vec<u8>>::new();
        state
            .visit_internal_checkpoint_records(123, |key, value| {
                records.insert(key.to_owned(), value.as_bytes().to_vec());
                Ok(())
            })
            .unwrap();
        let sidecar = state.production_history_sidecar();
        let mut identity = state.identity.clone();
        identity.generation += 1;
        identity.revision = state.revision;
        let mut reopened =
            CoreState::from_internal_records(identity, &records, state.catalog.as_ref().clone())
                .unwrap();
        if let Some(sidecar) = sidecar {
            reopened
                .restore_production_history_sidecar(sidecar)
                .unwrap();
        }
        reopened
    }

    fn assert_public_exact_state_equal_except_revision(
        batched: &CoreState,
        segmented: &CoreState,
        expected_revision_delta: u64,
        context: &str,
    ) {
        assert_eq!(
            batched.revision + expected_revision_delta,
            segmented.revision,
            "{context}: only the number of host commits may change revision metadata"
        );
        let batched_public = batched.materialize().unwrap();
        let segmented_public = segmented.materialize().unwrap();
        let differing_top_level_fields = batched_public
            .as_object()
            .unwrap()
            .iter()
            .filter_map(|(key, value)| {
                (segmented_public.get(key) != Some(value)).then_some(key.as_str())
            })
            .collect::<Vec<_>>();
        if differing_top_level_fields.contains(&"productionHistory") {
            let batched_history = batched_public["productionHistory"]
                .as_array()
                .expect("batched production history array");
            let segmented_history = segmented_public["productionHistory"]
                .as_array()
                .expect("segmented production history array");
            let first_difference = batched_history
                .iter()
                .zip(segmented_history)
                .position(|(left, right)| left != right)
                .unwrap_or_else(|| batched_history.len().min(segmented_history.len()));
            panic!(
                "{context}: production history first differs at sample {first_difference}; batched={:#} segmented={:#}",
                batched_history
                    .get(first_difference)
                    .unwrap_or(&Value::Null),
                segmented_history
                    .get(first_difference)
                    .unwrap_or(&Value::Null)
            );
        }
        assert!(
            differing_top_level_fields.is_empty(),
            "{context}: public v47 top-level differences: {differing_top_level_fields:?}"
        );
        let batched_public_bytes = serde_json::to_vec(&batched_public).unwrap();
        let segmented_public_bytes = serde_json::to_vec(&segmented_public).unwrap();
        assert_eq!(
            batched_public_bytes, segmented_public_bytes,
            "{context}: public v47 bytes must be identical before any revision normalization"
        );
        assert_eq!(
            batched.canonical_sha256().unwrap(),
            segmented.canonical_sha256().unwrap(),
            "{context}: public canonical hash"
        );
        assert_eq!(
            synthetic_conservation_sha256(batched),
            synthetic_conservation_sha256(segmented),
            "{context}: conservation hash"
        );
        let mut normalized_batched = batched.clone();
        normalized_batched.revision = segmented.revision;
        let batched_fingerprint = material_delivery_state_fingerprint(&normalized_batched);
        let segmented_fingerprint = material_delivery_state_fingerprint(segmented);
        if batched_fingerprint.0 != segmented_fingerprint.0 {
            let first_difference = batched_fingerprint
                .0
                .iter()
                .zip(&segmented_fingerprint.0)
                .position(|(left, right)| left != right)
                .unwrap_or_else(|| {
                    batched_fingerprint
                        .0
                        .len()
                        .min(segmented_fingerprint.0.len())
                });
            let start = first_difference.saturating_sub(80);
            let batched_end = (first_difference + 80).min(batched_fingerprint.0.len());
            let segmented_end = (first_difference + 80).min(segmented_fingerprint.0.len());
            panic!(
                "{context}: normalized public v47 bytes differ at {first_difference}; batched=`{}` segmented=`{}`",
                String::from_utf8_lossy(&batched_fingerprint.0[start..batched_end]),
                String::from_utf8_lossy(&segmented_fingerprint.0[start..segmented_end]),
            );
        }
        assert_eq!(
            (
                &batched_fingerprint.1,
                &batched_fingerprint.2,
                &batched_fingerprint.3,
            ),
            (
                &segmented_fingerprint.1,
                &segmented_fingerprint.2,
                &segmented_fingerprint.3,
            ),
            "{context}: canonical/domain hashes and conservation must all be identical after normalizing only host revision metadata"
        );
    }

    #[test]
    fn exact_multi_second_advance_matches_one_second_public_history_and_state() {
        for seconds in [2_u64, 5, 30] {
            let mut batched = production_history_segmentation_fixture();
            let mut segmented = batched.clone();
            let source_revision = batched.revision;
            assert!(batched.exact_history_clock().unwrap().history_clock_aligned);

            advance_exact_public_seconds(&mut batched, seconds as f64);
            assert_eq!(
                batched.revision,
                source_revision + 1,
                "one successful multi-second Core advance owns one revision"
            );
            let batch_clock = batched.exact_history_clock().unwrap();
            assert_eq!(batch_clock.revision, batched.revision);
            assert_eq!(batch_clock.elapsed_seconds, seconds as f64);
            assert_eq!(batch_clock.history_recorded_at, seconds as f64);
            assert!(batch_clock.history_clock_aligned);
            for _ in 0..seconds {
                advance_exact_public_seconds(&mut segmented, 1.0);
            }

            assert_eq!(
                batched.base_value()["productionHistory"],
                segmented.base_value()["productionHistory"],
                "{seconds}s exact batching must retain every public one-second production-history sample"
            );
            assert_public_exact_state_equal_except_revision(
                &batched,
                &segmented,
                seconds - 1,
                &format!("{seconds}s batch vs {seconds} one-second commits"),
            );

            let history = batched.base_value()["productionHistory"]
                .as_array()
                .unwrap();
            assert_eq!(history.len(), seconds as usize, "{seconds}s history");
            assert!(history.iter().enumerate().all(|(index, sample)| {
                sample["elapsedSeconds"].as_f64() == Some((index + 1) as f64)
                    && sample["sampleDurationSeconds"].as_f64() == Some(1.0)
            }));
            if seconds == 30 {
                assert_ne!(
                    history[8]["inventory"], history[9]["inventory"],
                    "the 10-second refresh must observe candidate inventory changes"
                );
                assert_ne!(
                    history[8]["logisticsEfficiency"], history[9]["logisticsEfficiency"],
                    "the 10-second refresh must observe candidate belt-flow changes"
                );
            }
        }
    }

    #[test]
    fn exact_quiescent_batch_replays_public_clock_and_history_boundaries() {
        for seconds in [2_u64, 30, 60] {
            let mut batched = quiescent_segmentation_fixture();
            let mut segmented = batched.clone();

            advance_exact_public_seconds(&mut batched, seconds as f64);
            for _ in 0..seconds {
                advance_exact_public_seconds(&mut segmented, 1.0);
            }

            assert_public_exact_state_equal_except_revision(
                &batched,
                &segmented,
                seconds - 1,
                &format!("{seconds}s quiescent batch vs public one-second boundaries"),
            );
            assert_eq!(
                batched.base_value()["productionHistory"]
                    .as_array()
                    .unwrap()
                    .len(),
                seconds as usize,
                "every quiescent public second must retain one history sample"
            );
            assert_eq!(
                batched.production_history_sidecar(),
                segmented.production_history_sidecar(),
                "quiescent compression must retain the same cold history tiers"
            );
        }
    }

    #[test]
    fn exact_quiescent_batch_failure_keeps_source_atomic() {
        let mut state = quiescent_segmentation_fixture();
        state.base_value_mut()["productionHistory"] = Value::from("invalid-history");
        let source_revision = state.revision;
        let source_public = serde_json::to_vec(&state.materialize().unwrap()).unwrap();
        let source_canonical = state.canonical_sha256().unwrap();
        let source_sidecar = state.production_history_sidecar();

        let error = state
            .advance(&CoreAdvanceRequest {
                base_revision: source_revision,
                simulation_seconds: 30.0,
                wall_seconds: 30.0,
                advance_mode: CoreAdvanceMode::Exact,
                include_diagnostics: false,
            })
            .unwrap_err();
        assert!(format!("{error:#}").contains("production history"));
        assert_eq!(state.revision, source_revision);
        assert_eq!(
            serde_json::to_vec(&state.materialize().unwrap()).unwrap(),
            source_public
        );
        assert_eq!(state.canonical_sha256().unwrap(), source_canonical);
        assert_eq!(state.production_history_sidecar(), source_sidecar);
    }

    #[test]
    fn exact_batch_campaign_reward_is_available_to_the_next_construction_second() {
        let mut batched = campaign_reward_consumption_segmentation_fixture();
        let mut segmented = batched.clone();

        advance_exact_public_seconds(&mut batched, 2.0);
        advance_exact_public_seconds(&mut segmented, 1.0);
        assert_eq!(admission_reason(&segmented).unwrap(), None);
        assert_eq!(
            segmented.base_value()["construction"]["thermal_power_plant"],
            json!(2.0),
            "the first construction pass plus Campaign reward must reach target stock"
        );
        assert_eq!(
            segmented.base_value()["constructionAutomation"]["totalCrafted"],
            json!(1.0),
            "only one thermal plant is crafted before Campaign grants the second"
        );
        advance_exact_public_seconds(&mut segmented, 1.0);

        assert_eq!(
            segmented.base_value()["construction"]["thermal_power_plant"],
            json!(2.0),
            "the second pass must observe target stock already satisfied"
        );
        assert_eq!(
            segmented.base_value()["constructionAutomation"]["totalCrafted"],
            json!(1.0)
        );
        assert_eq!(
            batched.base_value()["planetTrays"],
            segmented.base_value()["planetTrays"],
            "Campaign reward segmentation must not change persisted planet trays"
        );
        assert_public_exact_state_equal_except_revision(
            &batched,
            &segmented,
            1,
            "2s campaign reward-to-construction boundary",
        );
    }

    #[test]
    fn exact_batch_replays_research_and_orbital_public_call_boundaries() {
        let mut source = research_boundary_fixture(32, 1.0, 99_999.0);
        source
            .base_value_mut()
            .insert("orbitalStation".to_owned(), json!({ "status": "locked" }));
        source.base_value_mut()["totalProduced"]["universe_matrix"] = Value::from(1);
        let mut batched = source.clone();
        let mut segmented = source;

        advance_exact_public_seconds(&mut batched, 2.0);
        advance_exact_public_seconds(&mut segmented, 1.0);
        assert_eq!(admission_reason(&segmented).unwrap(), None);
        assert!(
            segmented.base_value()["research"]["completedTechIds"]
                .as_array()
                .is_some_and(|ids| ids.iter().any(|id| id == "research_speed_1"))
        );
        assert_eq!(
            segmented.base_value()["orbitalStation"]["status"],
            "eligible"
        );
        advance_exact_public_seconds(&mut segmented, 1.0);

        assert_public_exact_state_equal_except_revision(
            &batched,
            &segmented,
            1,
            "2s research completion and orbital eligibility call boundaries",
        );
    }

    #[test]
    fn exact_batch_uses_first_second_matrix_unlock_for_second_second_orbital_upload() {
        let source = orbital_unlock_segmentation_fixture();
        let mut batched = source.clone();
        let mut segmented = source;

        advance_exact_public_seconds(&mut batched, 2.0);
        advance_exact_public_seconds(&mut segmented, 1.0);
        assert_eq!(admission_reason(&segmented).unwrap(), None);
        assert!(
            finite_number(segmented.base_value()["totalProduced"].get("universe_matrix")) >= 1.0
        );
        assert_eq!(
            segmented.base_value()["orbitalStation"]["status"],
            "eligible"
        );
        let terminal_after_first = segmented
            .parse_entities_parallel()
            .unwrap()
            .into_iter()
            .find(|entity| entity["id"] == "orbital-unlock-terminal")
            .unwrap();
        assert_eq!(terminal_after_first["orbitalCargoTotalUploaded"], "0");

        advance_exact_public_seconds(&mut segmented, 1.0);
        let terminal_after_second = segmented
            .parse_entities_parallel()
            .unwrap()
            .into_iter()
            .find(|entity| entity["id"] == "orbital-unlock-terminal")
            .unwrap();
        assert_ne!(
            terminal_after_second["orbitalCargoTotalUploaded"],
            "0",
            "terminal={terminal_after_second:?} station={:?}",
            segmented.base_value()["orbitalStation"]
        );
        assert_ne!(
            segmented.base_value()["orbitalStation"]["construction"]["stageRequirements"][0]["delivered"]
                ["iron_ore"],
            "0"
        );
        assert_public_exact_state_equal_except_revision(
            &batched,
            &segmented,
            1,
            "first-second matrix unlock must authorize second-second orbital cargo",
        );
    }

    #[test]
    fn exact_batch_does_not_settle_campaign_on_fractional_activity_substeps() {
        let mut source = campaign_reward_consumption_segmentation_fixture();
        source.base_value_mut()["endgame"]["constructionActivity"] = json!({
            "activityId": "fractional-boundary-fixture",
            "activityClockMs": 0,
            "startsAtMs": 500,
            "endsAtMs": 1500
        });
        let mut batched = source.clone();
        let mut segmented = source;

        advance_exact_public_seconds(&mut batched, 2.0);
        advance_exact_public_seconds(&mut segmented, 1.0);
        advance_exact_public_seconds(&mut segmented, 1.0);

        assert_eq!(
            segmented.base_value()["construction"]["thermal_power_plant"],
            json!(2.0)
        );
        assert_eq!(
            segmented.base_value()["constructionAutomation"]["totalCrafted"],
            json!(1.0)
        );
        assert_public_exact_state_equal_except_revision(
            &batched,
            &segmented,
            1,
            "2s exact activity split must settle only recorded one-second boundaries",
        );
    }

    #[test]
    fn exact_batch_campaign_item_reward_wakes_sleeping_construction_next_second() {
        let source = campaign_item_reward_wakes_construction_fixture();
        let mut batched = source.clone();
        let mut segmented = source;

        advance_exact_public_seconds(&mut batched, 2.0);
        advance_exact_public_seconds(&mut segmented, 1.0);
        assert_eq!(
            segmented.base_value()["construction"]["spray_reward_building"],
            json!(0)
        );
        assert_eq!(
            segmented.base_value()["tray"]["proliferator_mk1"],
            json!(10.0)
        );
        advance_exact_public_seconds(&mut segmented, 1.0);
        assert_eq!(
            segmented.base_value()["construction"]["spray_reward_building"],
            json!(0)
        );
        assert_eq!(
            segmented.base_value()["tray"]["proliferator_mk1"],
            json!(9.0)
        );
        assert_eq!(
            segmented.base_value()["constructionAutomation"]["jobs"]["construction-center"]["constructionId"],
            "spray_reward_building",
            "the rewarded item must wake the sleeping construction row and fund its job"
        );
        assert_public_exact_state_equal_except_revision(
            &batched,
            &segmented,
            1,
            "Campaign item reward must wake construction for the next exact second",
        );
    }

    #[test]
    fn exact_batch_freezes_first_second_speedrun_milestone_time() {
        let source = speedrun_research_boundary_fixture();
        let mut batched = source.clone();
        let mut segmented = source;

        advance_exact_public_seconds(&mut batched, 2.0);
        advance_exact_public_seconds(&mut segmented, 1.0);
        assert_eq!(admission_reason(&segmented).unwrap(), None);
        assert_eq!(
            segmented.base_value()["speedrun"]["milestones"]["all_technologies"]["completedAtSeconds"],
            json!(1.0)
        );
        advance_exact_public_seconds(&mut segmented, 1.0);
        assert_eq!(
            segmented.base_value()["speedrun"]["elapsedActiveSeconds"],
            json!(2.0)
        );
        assert_eq!(
            segmented.base_value()["speedrun"]["milestones"]["all_technologies"]["completedAtSeconds"],
            json!(1.0),
            "a completed goal keeps its first-boundary time while the run clock continues"
        );
        assert_public_exact_state_equal_except_revision(
            &batched,
            &segmented,
            1,
            "speedrun milestone completion at the first exact boundary",
        );
    }

    #[test]
    fn exact_one_second_public_history_keeps_the_legacy_single_sample_bytes() {
        let mut state = production_history_segmentation_fixture();
        advance_exact_public_seconds(&mut state, 1.0);

        let expected = json!([{
            "elapsedSeconds": 1.0,
            "sampleDurationSeconds": 1.0,
            "productionPerMinute": { "iron_ingot": 0.0 },
            "consumptionPerMinute": { "iron_ore": 0.0 },
            "planetProductionPerMinute": { "home": { "iron_ingot": 0.0 } },
            "planetConsumptionPerMinute": { "home": { "iron_ore": 0.0 } },
            "inventory": { "iron_ingot": 300.0, "iron_ore": 110.0 },
            "generationKw": 300.0,
            "demandKw": 0.0,
            "machineEfficiency": 0.0,
            "logisticsEfficiency": 0.5,
            "powerEfficiency": 1.0,
            "activeMachines": 0.0,
            "blockedMachines": 33.0,
        }]);
        assert_eq!(
            serde_json::to_vec(&state.base_value()["productionHistory"]).unwrap(),
            serde_json::to_vec(&expected).unwrap(),
            "the inner sample must replace, not duplicate or alter, the established one-second outer sample"
        );
        assert_eq!(state.base_value()["historyRecordedAt"].as_f64(), Some(1.0));
    }

    #[test]
    fn fractional_unaligned_and_long_step_history_keep_the_legacy_outer_policy() {
        let base = construction_isolation_base();
        let base = base.as_object().unwrap();
        assert!(should_record_internal_exact_seconds(base, 1.0, 1.0));
        assert!(should_record_internal_exact_seconds(base, 30.0, 1.0));
        assert!(!should_record_internal_exact_seconds(base, 1.5, 1.0));
        assert!(!should_record_internal_exact_seconds(base, 28_801.0, 10.0));
        assert!(!should_record_internal_exact_seconds(base, 86_400.0, 30.0));

        let mut unaligned = production_history_segmentation_fixture();
        advance_exact_public_seconds(&mut unaligned, 0.5);
        assert!(
            unaligned.base_value()["productionHistory"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        advance_exact_public_seconds(&mut unaligned, 1.0);
        let history = unaligned.base_value()["productionHistory"]
            .as_array()
            .unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0]["elapsedSeconds"].as_f64(), Some(1.5));
        assert_eq!(history[0]["sampleDurationSeconds"].as_f64(), Some(1.5));

        let mut direct_fractional = production_history_segmentation_fixture();
        advance_exact_public_seconds(&mut direct_fractional, 1.5);
        let history = direct_fractional.base_value()["productionHistory"]
            .as_array()
            .unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0]["elapsedSeconds"].as_f64(), Some(1.5));
        assert_eq!(history[0]["sampleDurationSeconds"].as_f64(), Some(1.5));
    }

    #[test]
    fn exact_multi_second_history_survives_checkpoint_reload_and_statistics_projection() {
        let mut batched = production_history_segmentation_fixture();
        let mut segmented = batched.clone();
        advance_exact_public_seconds(&mut batched, 30.0);
        for _ in 0..30 {
            advance_exact_public_seconds(&mut segmented, 1.0);
        }

        let mut reopened_batched = reload_exact_history_checkpoint(&batched);
        let reopened_segmented = reload_exact_history_checkpoint(&segmented);
        assert_public_exact_state_equal_except_revision(
            &reopened_batched,
            &reopened_segmented,
            29,
            "checkpoint-reopened 30s batch",
        );
        let mut batched_projection = reopened_batched
            .statistics_projection(0.0, 30.0, 0, 64, Some("home"), Some("iron_ingot"))
            .unwrap();
        let segmented_projection = reopened_segmented
            .statistics_projection(0.0, 30.0, 0, 64, Some("home"), Some("iron_ingot"))
            .unwrap();
        batched_projection["revision"] = segmented_projection["revision"].clone();
        assert_eq!(
            serde_json::to_vec(&batched_projection).unwrap(),
            serde_json::to_vec(&segmented_projection).unwrap(),
            "tiered statistics must expose the same reloaded samples after normalizing only host revision metadata"
        );
        assert_eq!(
            reopened_batched.production_history_sidecar(),
            reopened_segmented.production_history_sidecar()
        );

        advance_exact_public_seconds(&mut reopened_batched, 5.0);
        let mut reopened_segmented = reopened_segmented;
        advance_exact_public_seconds(&mut reopened_segmented, 5.0);
        assert_public_exact_state_equal_except_revision(
            &reopened_batched,
            &reopened_segmented,
            29,
            "continued exact advance after checkpoint reload",
        );
    }

    fn advance_exact_with_worker_count(
        mut state: CoreState,
        seconds: f64,
        worker_count: usize,
    ) -> CoreState {
        let prepared = prepare_advance_with_runtime(
            &state,
            seconds,
            seconds,
            false,
            &DeterministicRuntime::for_test(worker_count),
        )
        .unwrap();
        commit_and_install_exact_factory_test_state(&mut state, prepared);
        state
    }

    #[test]
    fn exact_multi_second_history_is_identical_on_1_2_4_8_worker_runtimes() {
        let source = ordinary_oactive_fixture(4_163);
        let expected = advance_exact_with_worker_count(source.clone(), 30.0, 1);
        assert_eq!(
            expected.base_value()["productionHistory"]
                .as_array()
                .unwrap()
                .len(),
            30
        );
        for worker_count in [2, 4, 8] {
            let observed = advance_exact_with_worker_count(source.clone(), 30.0, worker_count);
            assert_public_exact_state_equal_except_revision(
                &observed,
                &expected,
                0,
                &format!("30s exact history with {worker_count} workers"),
            );
            assert_eq!(
                observed
                    .statistics_projection(0.0, 30.0, 0, 64, None, None)
                    .unwrap(),
                expected
                    .statistics_projection(0.0, 30.0, 0, 64, None, None)
                    .unwrap(),
                "statistics projection with {worker_count} workers"
            );
        }
    }

    #[test]
    fn committed_factory_diagnostics_report_writer_and_active_scan_evidence() {
        let source = ordinary_oactive_fixture(1_024);
        let source_revision = source.revision;
        let advanced = advance_exact_with_worker_count(source, 5.0, 4);
        let diagnostics = advanced
            .factory_execution_diagnostics()
            .expect("successful exact advance installs bounded diagnostics");

        assert_eq!(diagnostics.source_revision, source_revision);
        assert_eq!(diagnostics.result_revision, advanced.revision);
        assert_eq!(diagnostics.steps, 5);
        assert_eq!(diagnostics.simulation_seconds, 5.0);
        assert_eq!(diagnostics.worker_limit, 4);
        assert!(diagnostics.writer_submitted_rows >= diagnostics.writer_unique_rows);
        assert!(
            diagnostics
                .writer_domains
                .iter()
                .any(|domain| domain == "production")
        );
        assert!(
            diagnostics
                .stage_scans
                .iter()
                .any(|stage| stage.stage == "ordinary-production" && stage.scan.invocations == 5)
        );
        assert!(serde_json::to_vec(diagnostics).unwrap().len() < 16 * 1024);
    }

    #[test]
    fn exact_multi_second_history_candidate_failure_keeps_source_atomic() {
        let mut state = production_history_segmentation_fixture();
        advance_exact_public_seconds(&mut state, 1.0);
        let source_belt_routes = state.prepared_belt_routes().unwrap();
        let source_ordinary_runtime = state.prepared_ordinary_production_runtime().unwrap();
        let source_planet_runtime = state.prepared_planet_metrics_runtime().unwrap();
        let source_power_runtime = state.prepared_power_probe_runtime().unwrap();
        let source_construction_runtime = state.prepared_construction_runtime().unwrap();
        state.base_value_mut().remove("campaign");
        let source_revision = state.revision;
        let source_public = serde_json::to_vec(&state.materialize().unwrap()).unwrap();
        let source_canonical = state.canonical_sha256().unwrap();
        let source_domain = state.domain_sha256().unwrap();
        let source_conservation = synthetic_conservation_sha256(&state);
        let source_sidecar = state.production_history_sidecar();

        let error = state
            .advance(&CoreAdvanceRequest {
                base_revision: source_revision,
                simulation_seconds: 5.0,
                wall_seconds: 5.0,
                advance_mode: CoreAdvanceMode::Exact,
                include_diagnostics: false,
            })
            .unwrap_err();
        assert!(format!("{error:#}").contains("native campaign state is missing"));
        assert_eq!(state.revision, source_revision);
        assert_eq!(
            serde_json::to_vec(&state.materialize().unwrap()).unwrap(),
            source_public
        );
        assert_eq!(state.canonical_sha256().unwrap(), source_canonical);
        assert_eq!(state.domain_sha256().unwrap(), source_domain);
        assert_eq!(synthetic_conservation_sha256(&state), source_conservation);
        assert_eq!(state.production_history_sidecar(), source_sidecar);
        assert!(std::sync::Arc::ptr_eq(
            &state.prepared_belt_routes().unwrap(),
            &source_belt_routes
        ));
        assert!(std::sync::Arc::ptr_eq(
            &state.prepared_ordinary_production_runtime().unwrap(),
            &source_ordinary_runtime
        ));
        assert!(std::sync::Arc::ptr_eq(
            &state.prepared_planet_metrics_runtime().unwrap(),
            &source_planet_runtime
        ));
        assert!(std::sync::Arc::ptr_eq(
            &state.prepared_power_probe_runtime().unwrap(),
            &source_power_runtime
        ));
        assert!(std::sync::Arc::ptr_eq(
            &state.prepared_construction_runtime().unwrap(),
            &source_construction_runtime
        ));
    }

    fn assert_history_partition(state: &CoreState, durations: &[f64], context: &str) {
        let public = state.materialize().unwrap();
        let history = public["productionHistory"]
            .as_array()
            .expect("production history fixture must remain an array");
        assert_eq!(history.len(), durations.len(), "{context}: bucket count");
        let mut elapsed = 0.0;
        for (index, (&duration, sample)) in durations.iter().zip(history).enumerate() {
            elapsed += duration;
            assert_eq!(
                sample["sampleDurationSeconds"].as_f64(),
                Some(duration),
                "{context}: bucket {index} duration"
            );
            assert_eq!(
                sample["elapsedSeconds"].as_f64(),
                Some(elapsed),
                "{context}: bucket {index} endpoint"
            );
        }
        assert_eq!(
            public["historyRecordedAt"].as_f64(),
            Some(elapsed),
            "{context}: public history clock"
        );
    }

    fn assert_forced_legacy_step_state_equal_except_history_and_revision(
        long: &CoreState,
        segmented: &CoreState,
        step_size: f64,
        segment_count: usize,
        context: &str,
    ) {
        assert_history_partition(long, &[60.0], &format!("{context}: long call"));
        assert_history_partition(
            segmented,
            &vec![step_size; segment_count],
            &format!("{context}: segmented calls"),
        );

        let mut normalized_long_public = long.materialize().unwrap();
        let mut normalized_segmented_public = segmented.materialize().unwrap();
        let long_history = normalized_long_public
            .as_object_mut()
            .unwrap()
            .remove("productionHistory")
            .unwrap();
        let segmented_history = normalized_segmented_public
            .as_object_mut()
            .unwrap()
            .remove("productionHistory")
            .unwrap();
        assert_ne!(
            long_history, segmented_history,
            "{context}: the explicit 10/30-second public call partitions must remain observable"
        );
        assert!(
            normalized_long_public == normalized_segmented_public,
            "{context}: only productionHistory may differ between the forced legacy call partitions"
        );
        assert_eq!(
            serde_json::to_vec(&normalized_long_public).unwrap(),
            serde_json::to_vec(&normalized_segmented_public).unwrap(),
            "{context}: every non-history public v47 byte"
        );
        assert_eq!(
            synthetic_conservation_sha256(long),
            synthetic_conservation_sha256(segmented),
            "{context}: conservation hash"
        );

        // Canonical state includes the intentionally different public history.
        // Replacing exactly that one field (and host revision metadata) must
        // make the complete persisted fingerprint byte-identical.
        let mut normalized_long = long.clone();
        normalized_long.revision = segmented.revision;
        assert_eq!(
            normalized_long.domain_sha256().unwrap(),
            segmented.domain_sha256().unwrap(),
            "{context}: domain hash after normalizing only host revision metadata"
        );
        normalized_long
            .base_value_mut()
            .insert("productionHistory".to_owned(), segmented_history);
        assert_eq!(
            material_delivery_state_fingerprint(&normalized_long),
            material_delivery_state_fingerprint(segmented),
            "{context}: replacing only the documented call-bucket history and revision must close the complete fingerprint"
        );
    }

    fn run_research_boundary_advance(
        seconds: f64,
        worker_count: usize,
        force_full_scan: bool,
        infinite: bool,
    ) -> OrdinaryOactiveRun {
        let runtime = DeterministicRuntime::for_test(worker_count);
        let mut state = if infinite {
            infinite_research_boundary_fixture(4_163, 120.0, 24, "0", true)
        } else {
            research_boundary_fixture(4_163, 120.0, 0.0)
        };
        if force_full_scan {
            install_forced_ordinary_oracle(&mut state);
        }
        let prepared =
            prepare_advance_with_runtime(&state, seconds, seconds, false, &runtime).unwrap();
        let scans = prepared
            .ordinary_production_runtime
            .scan_history_for_test()
            .to_vec();
        let next_revision = state.revision + 1;
        state
            .commit_simulated_state(
                prepared.base,
                prepared.entities,
                prepared.belt_commit,
                next_revision,
                false,
            )
            .unwrap();
        OrdinaryOactiveRun {
            bytes: serde_json::to_vec(&state.materialize().unwrap()).unwrap(),
            canonical: state.canonical_sha256().unwrap(),
            domain: state.domain_sha256().unwrap(),
            conservation: synthetic_conservation_sha256(&state),
            scans,
        }
    }

    fn ordinary_oactive_fixture(machine_count: usize) -> CoreState {
        let mut base = construction_isolation_base();
        base["settings"]["resourceMode"] = Value::from("finite");
        let mut entities = vec![json!({
            "id": "ordinary-oactive-thermal",
            "kind": "power",
            "planetId": "home",
            "powerGridId": "grid-a",
            "buildingId": "thermal_power_plant",
            "machineCount": 1,
            "minerCount": 0,
            "fuelItemId": "coal",
            "fuelRemainingMj": 0,
            "inputs": { "coal": 1 },
            "outputs": {},
            "progress": 0,
            "utilization": 0,
            "productionRate": 0,
            "routingCursor": 0
        })];
        entities.extend((0..machine_count).map(|index| {
            ordinary_oactive_machine(
                index,
                if index == 0 { 100.0 } else { 0.0 },
                if index == 1 { 100.0 } else { 0.0 },
            )
        }));
        entities.extend([
            ordinary_oactive_vein("ordinary-oactive-zero-miner", 0.0, 0.0, 100.0),
            ordinary_oactive_vein("ordinary-oactive-full-miner", 1.0, 100.0, 100.0),
            ordinary_oactive_vein("ordinary-oactive-depleted-miner", 1.0, 0.0, 0.0),
        ]);
        fixture_state_from_base_with_registry(
            base,
            &entities,
            crate::command::EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT,
        )
    }

    fn ordinary_oactive_quiesce_fixture() -> CoreState {
        let mut base = construction_isolation_base();
        base["settings"]["resourceMode"] = Value::from("finite");
        let mut entities = vec![json!({
            "id": "ordinary-oactive-wind",
            "kind": "power",
            "planetId": "home",
            "powerGridId": "grid-a",
            "buildingId": "wind_turbine",
            "machineCount": 1,
            "minerCount": 0,
            "inputs": {},
            "outputs": {},
            "progress": 0,
            "utilization": 0,
            "productionRate": 0,
            "routingCursor": 0
        })];
        let mut last_input = ordinary_oactive_machine(20_000, 1.0, 0.0);
        last_input["id"] = Value::from("ordinary-oactive-last-input");
        entities.push(last_input);
        let mut filled_machine = ordinary_oactive_machine(20_001, 10.0, 99.0);
        filled_machine["id"] = Value::from("ordinary-oactive-filled-machine");
        entities.push(filled_machine);
        entities.push(ordinary_oactive_vein(
            "ordinary-oactive-exhausted-vein",
            1.0,
            0.0,
            1.0,
        ));
        entities.push(ordinary_oactive_vein(
            "ordinary-oactive-filled-vein",
            1.0,
            99.0,
            100.0,
        ));
        entities.extend((0..20).map(|index| ordinary_oactive_machine(30_000 + index, 0.0, 0.0)));
        fixture_state_from_base_with_registry(
            base,
            &entities,
            crate::command::EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT,
        )
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    struct OrdinaryOactiveRun {
        bytes: Vec<u8>,
        canonical: String,
        domain: String,
        conservation: String,
        scans: Vec<crate::ordinary_production::OrdinaryProductionScan>,
    }

    fn run_ordinary_oactive_advance(
        seconds: f64,
        worker_count: usize,
        force_full_scan: bool,
    ) -> OrdinaryOactiveRun {
        let runtime = DeterministicRuntime::for_test(worker_count);
        let mut state = ordinary_oactive_fixture(PARALLEL_MIN_ITEMS + 65);
        if force_full_scan {
            let mut production = state
                .prepared_ordinary_production_runtime()
                .expect("production runtime");
            std::sync::Arc::make_mut(&mut production).force_full_scan_for_test(true);
            state.install_prepared_ordinary_production_runtime(production);
        }
        let prepared =
            prepare_advance_with_runtime(&state, seconds, seconds, false, &runtime).unwrap();
        let scans = prepared
            .ordinary_production_runtime
            .scan_history_for_test()
            .to_vec();
        let next_revision = state.revision + 1;
        state
            .commit_simulated_state(
                prepared.base,
                prepared.entities,
                prepared.belt_commit,
                next_revision,
                false,
            )
            .unwrap();
        OrdinaryOactiveRun {
            bytes: serde_json::to_vec(&state.materialize().unwrap()).unwrap(),
            canonical: state.canonical_sha256().unwrap(),
            domain: state.domain_sha256().unwrap(),
            conservation: synthetic_conservation_sha256(&state),
            scans,
        }
    }

    fn install_forced_ordinary_oracle(state: &mut CoreState) {
        let entities = state.parse_entities_parallel().unwrap();
        let mut runtime = std::sync::Arc::new(
            crate::ordinary_production::OrdinaryProductionRuntime::build(state, &entities),
        );
        std::sync::Arc::make_mut(&mut runtime).force_full_scan_for_test(true);
        state.install_prepared_ordinary_production_runtime(runtime);
    }

    fn advance_and_install_ordinary_test_state(
        state: &mut CoreState,
        seconds: f64,
    ) -> Vec<crate::ordinary_production::OrdinaryProductionScan> {
        let prepared = prepare_advance_with_runtime(
            state,
            seconds,
            seconds,
            false,
            &DeterministicRuntime::for_test(4),
        )
        .unwrap();
        let belt_routes = prepared.belt_routes.clone();
        let belt_activity = prepared.belt_activity.clone();
        let logistics_buffer_runtime = prepared.logistics_buffer_runtime.clone();
        let material_delivery_runtime = prepared.material_delivery_runtime.clone();
        let ordinary_production_runtime = prepared.ordinary_production_runtime.clone();
        let planet_metrics_runtime = prepared.planet_metrics_runtime.clone();
        let power_probe_runtime = prepared.power_probe_runtime.clone();
        let local_peer_directory = prepared.local_peer_directory.clone();
        let quantum_logistics_directory = prepared.quantum_logistics_directory.clone();
        let construction_runtime = prepared.construction_runtime.clone();
        let station_mode_transition_runtime = prepared.station_mode_transition_runtime.clone();
        let quantum_transition_runtime = prepared.quantum_transition_runtime.clone();
        let interstellar_peer_directory = prepared.interstellar_peer_directory.clone();
        let interstellar_route_activity = prepared.interstellar_route_activity.clone();
        let scans = ordinary_production_runtime.scan_history_for_test().to_vec();
        let next_revision = state.revision + 1;
        state
            .commit_simulated_state(
                prepared.base,
                prepared.entities,
                prepared.belt_commit,
                next_revision,
                false,
            )
            .unwrap();
        state.install_prepared_belt_routes(belt_routes);
        state.install_prepared_belt_activity(belt_activity);
        state.install_prepared_logistics_buffer_runtime(logistics_buffer_runtime);
        state.install_prepared_material_delivery_runtime(material_delivery_runtime);
        state.install_prepared_ordinary_production_runtime(ordinary_production_runtime);
        state.install_prepared_planet_metrics_runtime(planet_metrics_runtime);
        state.install_prepared_power_probe_runtime(power_probe_runtime);
        state.install_prepared_local_peer_directory(local_peer_directory);
        state.install_prepared_quantum_logistics_directory(quantum_logistics_directory);
        state.install_prepared_construction_runtime(construction_runtime);
        state.install_prepared_station_mode_transition_runtime(station_mode_transition_runtime);
        state.install_prepared_quantum_transition_runtime(quantum_transition_runtime);
        state.install_prepared_interstellar_peer_directory(interstellar_peer_directory);
        state.install_prepared_interstellar_route_activity(interstellar_route_activity);
        scans
    }

    fn replace_thermal_fuel(state: &mut CoreState, coal: f64) {
        let index = state
            .entity_index
            .get("ordinary-oactive-thermal")
            .copied()
            .unwrap();
        let mut thermal = state.parse_entity(index).unwrap();
        thermal["inputs"]["coal"] = Value::from(coal);
        thermal["fuelRemainingMj"] = Value::from(0.0);
        state.replace_entity_raw(index, serde_json::to_string(&thermal).unwrap().into());
        state.rebuild_indexes().unwrap();
    }

    #[test]
    fn ordinary_oactive_matches_force_full_bytes_and_all_hashes_at_1_5_60_and_workers() {
        for seconds in [1.0, 5.0, 60.0] {
            let indexed = run_ordinary_oactive_advance(seconds, 1, false);
            let oracle = run_ordinary_oactive_advance(seconds, 1, true);
            assert_eq!(
                (
                    &indexed.bytes,
                    &indexed.canonical,
                    &indexed.domain,
                    &indexed.conservation
                ),
                (
                    &oracle.bytes,
                    &oracle.canonical,
                    &oracle.domain,
                    &oracle.conservation
                ),
                "ordinary production diverged from force-full oracle at {seconds}s"
            );
            assert_eq!(indexed.scans[0].selected_rows, indexed.scans[0].total_rows);
            assert!(indexed.scans[0].full_scan);
            assert!(oracle.scans.iter().all(|scan| scan.full_scan));
            eprintln!(
                "ORDINARY_OACTIVE_EVIDENCE seconds={seconds} scans={:?} canonical={} domain={} conservation={}",
                indexed
                    .scans
                    .iter()
                    .map(|scan| scan.selected_rows)
                    .collect::<Vec<_>>(),
                indexed.canonical,
                indexed.domain,
                indexed.conservation,
            );
            if seconds > 1.0 {
                assert!(indexed.scans.iter().skip(1).all(|scan| !scan.full_scan));
                assert!(
                    indexed
                        .scans
                        .iter()
                        .skip(1)
                        .all(|scan| scan.selected_rows <= 2)
                );
            }
        }

        let expected = run_ordinary_oactive_advance(60.0, 1, false);
        for worker_count in [2, 4, 8] {
            let observed = run_ordinary_oactive_advance(60.0, worker_count, false);
            assert_eq!(
                (
                    &observed.bytes,
                    &observed.canonical,
                    &observed.domain,
                    &observed.conservation
                ),
                (
                    &expected.bytes,
                    &expected.canonical,
                    &expected.domain,
                    &expected.conservation
                ),
                "ordinary production diverged at {worker_count} workers"
            );
            assert_eq!(observed.scans, expected.scans);
        }
        assert_eq!(run_ordinary_oactive_advance(60.0, 8, false), expected);
    }

    #[test]
    fn active_long_research_keeps_4164_rows_sparse_and_matches_force_full_at_1_5_60() {
        for infinite in [false, true] {
            for seconds in [1.0, 5.0, 60.0] {
                let indexed = run_research_boundary_advance(seconds, 1, false, infinite);
                let oracle = run_research_boundary_advance(seconds, 1, true, infinite);
                assert_eq!(
                    (
                        &indexed.bytes,
                        &indexed.canonical,
                        &indexed.domain,
                        &indexed.conservation,
                    ),
                    (
                        &oracle.bytes,
                        &oracle.canonical,
                        &oracle.domain,
                        &oracle.conservation,
                    ),
                    "research boundary diverged at {seconds}s infinite={infinite}"
                );
                assert_eq!(indexed.scans[0].selected_rows, 4_164);
                assert!(indexed.scans[0].full_scan);
                assert!(oracle.scans.iter().all(|scan| scan.full_scan));
                if seconds > 1.0 {
                    assert!(indexed.scans.iter().skip(1).all(|scan| !scan.full_scan));
                    assert!(
                        indexed
                            .scans
                            .iter()
                            .skip(1)
                            .all(|scan| scan.selected_rows <= 3),
                        "steady active research should retain only the barrier and live ordinary rows: {:?}",
                        indexed
                            .scans
                            .iter()
                            .map(|scan| scan.selected_rows)
                            .collect::<Vec<_>>()
                    );
                }
                eprintln!(
                    "RESEARCH_BOUNDARY_OACTIVE_EVIDENCE infinite={infinite} seconds={seconds} scans={:?} canonical={} domain={} conservation={}",
                    indexed
                        .scans
                        .iter()
                        .map(|scan| scan.selected_rows)
                        .collect::<Vec<_>>(),
                    indexed.canonical,
                    indexed.domain,
                    indexed.conservation,
                );
            }
        }

        for infinite in [false, true] {
            let expected = run_research_boundary_advance(60.0, 1, false, infinite);
            for worker_count in [2, 4, 8] {
                let observed = run_research_boundary_advance(60.0, worker_count, false, infinite);
                assert_eq!(
                    observed, expected,
                    "infinite={infinite} workers={worker_count}"
                );
            }
        }
    }

    #[test]
    fn material_delivery_oactive_matches_flat_full_at_1_5_60_and_workers() {
        for seconds in [1.0, 5.0, 60.0] {
            let indexed = run_material_delivery_oactive_advance(seconds, 1, false);
            let flat_full = run_material_delivery_oactive_advance(seconds, 1, true);
            assert_eq!(
                (
                    &indexed.bytes,
                    &indexed.canonical,
                    &indexed.domain,
                    &indexed.conservation,
                ),
                (
                    &flat_full.bytes,
                    &flat_full.canonical,
                    &flat_full.domain,
                    &flat_full.conservation,
                ),
                "material delivery diverged at {seconds}s"
            );
            assert_eq!(indexed.scans.len(), seconds as usize * 2);
            assert_eq!(indexed.scans[0].selected_rows, 1_024);
            assert_eq!(indexed.scans[1].selected_rows, 1_024);
            assert!(indexed.scans[0].full_scan && indexed.scans[1].full_scan);
            assert!(
                indexed
                    .scans
                    .iter()
                    .skip(2)
                    .all(|scan| !scan.full_scan && scan.selected_rows <= 1),
                "steady delivery scans must remain sparse: {:?}",
                indexed
                    .scans
                    .iter()
                    .map(|scan| scan.selected_rows)
                    .collect::<Vec<_>>()
            );
            assert!(flat_full.scans.iter().all(|scan| scan.full_scan));
            assert!(
                flat_full
                    .scans
                    .iter()
                    .all(|scan| scan.selected_rows == 1_024)
            );
        }

        let expected = run_material_delivery_oactive_advance(60.0, 1, false);
        for worker_count in [2, 4, 8] {
            assert_eq!(
                run_material_delivery_oactive_advance(60.0, worker_count, false),
                expected,
                "material delivery workers={worker_count}"
            );
        }
    }

    #[test]
    fn material_delivery_real_belts_wake_both_drain_phases_after_cold_step() {
        let indexed = run_material_delivery_oactive_advance(5.0, 4, false);
        let flat_full = run_material_delivery_oactive_advance(5.0, 4, true);
        assert_eq!(
            (
                &indexed.bytes,
                &indexed.canonical,
                &indexed.domain,
                &indexed.conservation,
            ),
            (
                &flat_full.bytes,
                &flat_full.canonical,
                &flat_full.domain,
                &flat_full.conservation,
            )
        );
        let steady = indexed.scans[2..]
            .chunks_exact(2)
            .map(|pair| (pair[0].selected_rows, pair[1].selected_rows))
            .collect::<Vec<_>>();
        assert!(
            steady.contains(&(1, 1)),
            "a relay belt must wake the pre-production drain while a producer belt wakes the post-production drain: {steady:?}"
        );
        let materialized: Value = serde_json::from_slice(&indexed.bytes).unwrap();
        let hub = materialized["entities"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entity| entity["id"] == "material-delivery-hub-00000")
            .unwrap();
        assert_eq!(hub["inputs"]["iron_ingot"], json!(0.0));
        assert!(materialized["tray"]["iron_ingot"].as_f64().unwrap() > 1.0);
    }

    #[test]
    fn material_delivery_real_output_belt_wakes_sleeping_hub_as_source() {
        let mut state = material_delivery_output_belt_fixture(64);
        advance_material_delivery_test_state(&mut state, 1.0, 1.0);
        let hub_index = state.factory_topology.material_delivery_hub_indices[0];
        let after_cold = state.parse_entity(hub_index).unwrap();
        let cold_output = after_cold["outputs"]["iron_ingot"].as_f64().unwrap();
        assert!(cold_output > 0.0 && cold_output < 100.0);
        assert!(
            state
                .prepared_material_delivery_runtime()
                .unwrap()
                .pending_rows_for_test()
                .is_empty(),
            "output inventory alone must not keep a delivery hub awake"
        );

        advance_material_delivery_test_state(&mut state, 1.0, 1.0);
        let runtime = state.prepared_material_delivery_runtime().unwrap();
        let scans = runtime.scan_history_for_test();
        let steady_pair = &scans[scans.len() - 2..];
        assert_eq!(
            steady_pair
                .iter()
                .map(|scan| scan.selected_rows)
                .collect::<Vec<_>>(),
            vec![1, 1],
            "a real source-side output movement must wake the hub before the first drain and carry it through the second"
        );
        let after_wake = state.parse_entity(hub_index).unwrap();
        assert!(after_wake["outputs"]["iron_ingot"].as_f64().unwrap() < cold_output);
        let belt_index = state
            .belt_index
            .get("material-delivery-hub-to-output-sink")
            .copied()
            .unwrap();
        assert!(
            state.parse_belt(belt_index).unwrap()["totalTransferred"]
                .as_f64()
                .unwrap()
                > 0.0
        );
    }

    #[test]
    fn material_delivery_long_advance_matches_segmented_commits_at_1_10_30_second_steps() {
        for (step_size, segments) in [
            (1.0, vec![1.0; 60]),
            (10.0, vec![10.0; 6]),
            (30.0, vec![30.0; 2]),
        ] {
            let mut long = material_delivery_segment_fixture(64);
            let long_source_revision = long.revision;
            advance_material_delivery_test_state(&mut long, 60.0, step_size);

            let mut segmented = material_delivery_segment_fixture(64);
            let segmented_source_revision = segmented.revision;
            for &seconds in &segments {
                advance_material_delivery_test_state(&mut segmented, seconds, step_size);
            }

            assert_eq!(long.revision, long_source_revision + 1);
            assert_eq!(
                segmented.revision,
                segmented_source_revision + segments.len() as u64
            );
            assert_ne!(
                long.revision, segmented.revision,
                "revision is deliberately asserted outside the complete persisted-state comparison"
            );
            let context =
                format!("material delivery state diverged for {step_size}s internal steps");
            if step_size == 1.0 {
                assert_public_exact_state_equal_except_revision(
                    &long,
                    &segmented,
                    segments.len() as u64 - 1,
                    &context,
                );
            } else {
                assert_forced_legacy_step_state_equal_except_history_and_revision(
                    &long,
                    &segmented,
                    step_size,
                    segments.len(),
                    &context,
                );
            }
            let long_runtime = long.prepared_material_delivery_runtime().unwrap();
            let segmented_runtime = segmented.prepared_material_delivery_runtime().unwrap();
            assert_eq!(
                long_runtime.scan_history_for_test(),
                segmented_runtime.scan_history_for_test(),
                "{context}: runtime scan history"
            );
            assert_eq!(
                long_runtime.pending_rows_for_test(),
                segmented_runtime.pending_rows_for_test(),
                "{context}: pending rows"
            );
            assert_eq!(
                long_runtime.scan_history_for_test().len(),
                (60.0 / step_size) as usize * 2
            );
        }
    }

    #[test]
    fn material_delivery_cold_dense_full_tray_mod_opaque_and_drift_fail_closed() {
        let state = material_delivery_oactive_fixture(8);
        let entities = state.parse_entities_parallel().unwrap();
        let hub_indices = state.factory_topology.material_delivery_hub_indices.clone();
        let mut runtime =
            crate::material_delivery::MaterialDeliveryRuntime::build(&state, &entities);
        let cold_first = runtime.select(&state, &entities);
        assert_eq!(cold_first.scan.selected_rows, 8);
        assert!(cold_first.scan.full_scan);
        runtime.commit_first_phase(cold_first);
        let cold_second = runtime.select(&state, &entities);
        assert_eq!(cold_second.scan.selected_rows, 8);
        assert!(cold_second.scan.full_scan);
        runtime
            .commit_second_phase(
                cold_second,
                &hub_indices
                    .iter()
                    .copied()
                    .map(|index| (index, false))
                    .collect::<Vec<_>>(),
            )
            .unwrap();
        let quiet = runtime.select(&state, &entities);
        assert_eq!(quiet.scan.selected_rows, 0);
        assert_eq!(quiet.scan.stable_rows_skipped, 8);

        runtime.wake_from_changed_entities(&state, &hub_indices[..6]);
        let dense = runtime.select(&state, &entities);
        assert_eq!(dense.scan.selected_rows, 8);
        assert!(dense.scan.dense_fallback && dense.scan.full_scan);

        let mut full_base = state.base_value().clone();
        full_base["tray"]["iron_ingot"] = Value::from(1_000);
        full_base["planetTrayItemLimits"]["home"] = Value::from(1_000);
        let mut full_entities = entities.clone();
        let mut full_runtime =
            crate::material_delivery::MaterialDeliveryRuntime::build(&state, &full_entities);
        drain_material_delivery_hubs(
            &state,
            &mut full_base,
            &mut full_entities,
            &mut full_runtime,
            1.0,
            false,
            MaterialDeliveryDrainMode::Indexed,
        )
        .unwrap();
        drain_material_delivery_hubs(
            &state,
            &mut full_base,
            &mut full_entities,
            &mut full_runtime,
            1.0,
            true,
            MaterialDeliveryDrainMode::Indexed,
        )
        .unwrap();
        assert_eq!(full_runtime.pending_rows_for_test(), hub_indices);
        for &index in &hub_indices {
            assert_eq!(full_entities[index]["utilization"], json!(0.0));
            assert_eq!(full_entities[index]["productionRate"], json!(0.0));
            assert_eq!(full_entities[index]["progress"], json!(0.0));
        }

        let mut mod_state = state.clone();
        mod_state.identity.registry_fingerprint = "mod:opaque-writer".to_owned();
        let mod_scan =
            crate::material_delivery::MaterialDeliveryRuntime::build(&mod_state, &entities)
                .select(&mod_state, &entities)
                .scan;
        assert!(mod_scan.directory_fallback && mod_scan.full_scan);

        let mut opaque_entities = entities.clone();
        opaque_entities[hub_indices[0]]["mod:inventory-writer"] = json!({ "enabled": true });
        let opaque_scan =
            crate::material_delivery::MaterialDeliveryRuntime::build(&state, &opaque_entities)
                .select(&state, &opaque_entities)
                .scan;
        assert!(opaque_scan.directory_fallback && opaque_scan.full_scan);

        let mut drift_entities = entities.clone();
        let mut drift_runtime =
            crate::material_delivery::MaterialDeliveryRuntime::build(&state, &drift_entities);
        let first = drift_runtime.select(&state, &drift_entities);
        drift_runtime.commit_first_phase(first);
        let second = drift_runtime.select(&state, &drift_entities);
        drift_runtime
            .commit_second_phase(
                second,
                &hub_indices
                    .iter()
                    .copied()
                    .map(|index| (index, false))
                    .collect::<Vec<_>>(),
            )
            .unwrap();
        drift_entities[hub_indices[3]]["id"] = Value::from("identity-drift");
        drift_runtime.wake_from_changed_entities(&state, &[hub_indices[3]]);
        let drift = drift_runtime.select(&state, &drift_entities);
        assert!(drift.scan.directory_fallback && drift.scan.full_scan);

        let mut rebuilt_topology = state.clone();
        let topology_pointer_before = std::sync::Arc::as_ptr(&rebuilt_topology.factory_topology);
        let topology_len = rebuilt_topology
            .factory_topology
            .material_delivery_hub_indices
            .len();
        let topology_capacity = rebuilt_topology
            .factory_topology
            .material_delivery_hub_indices
            .capacity();
        std::sync::Arc::make_mut(&mut rebuilt_topology.factory_topology)
            .material_delivery_hub_indices
            .swap(0, 1);
        assert_eq!(
            rebuilt_topology
                .factory_topology
                .material_delivery_hub_indices
                .len(),
            topology_len
        );
        assert_eq!(
            rebuilt_topology
                .factory_topology
                .material_delivery_hub_indices
                .capacity(),
            topology_capacity
        );
        assert_ne!(
            std::sync::Arc::as_ptr(&rebuilt_topology.factory_topology),
            topology_pointer_before,
            "the runtime-held Arc must force COW even for same-length/same-capacity edits"
        );
        let rebuilt = runtime.select(&rebuilt_topology, &entities);
        assert!(rebuilt.scan.directory_fallback && rebuilt.scan.full_scan);

        let peak_estimate = runtime.estimated_bytes();
        let one_runtime_and_full_key_payload =
            std::mem::size_of::<crate::material_delivery::MaterialDeliveryRuntime>() as u64
                + 256
                + hub_indices.len() as u64 * std::mem::size_of::<usize>() as u64 * 4;
        assert!(
            peak_estimate >= one_runtime_and_full_key_payload * 2,
            "memory estimate must include first-node overhead, a full temporary selection, and source/candidate COW copies"
        );
    }

    #[test]
    fn failed_material_delivery_candidate_retains_source_wake_and_bytes() {
        let mut state = material_delivery_oactive_fixture(8);
        advance_and_install_ordinary_test_state(&mut state, 1.0);
        let hub_index = state.factory_topology.material_delivery_hub_indices[4];
        let mut runtime = state
            .prepared_material_delivery_runtime()
            .expect("material delivery runtime");
        std::sync::Arc::make_mut(&mut runtime).wake_from_changed_entities(&state, &[hub_index]);
        state.install_prepared_material_delivery_runtime(runtime);
        state.base_value_mut().remove("totalProduced");
        let source_bytes = serde_json::to_vec(&state.materialize().unwrap()).unwrap();
        let source_runtime = state
            .prepared_material_delivery_runtime()
            .expect("source material delivery runtime");
        let pending = source_runtime.pending_rows_for_test();
        let history = source_runtime.scan_history_for_test().to_vec();
        let error = prepare_advance_with_runtime(
            &state,
            1.0,
            1.0,
            false,
            &DeterministicRuntime::for_test(4),
        )
        .err()
        .expect("malformed totalProduced must fail");
        assert!(format!("{error:#}").contains("total production record is missing"));
        assert_eq!(
            serde_json::to_vec(&state.materialize().unwrap()).unwrap(),
            source_bytes
        );
        let retained = state
            .prepared_material_delivery_runtime()
            .expect("retained material delivery runtime");
        assert!(std::sync::Arc::ptr_eq(&source_runtime, &retained));
        assert_eq!(retained.pending_rows_for_test(), pending);
        assert_eq!(retained.scan_history_for_test(), history);
    }

    #[test]
    fn research_boundary_proof_is_fail_closed_for_completion_queue_and_opaque_state() {
        let state = research_boundary_fixture(32, 100_000.0, 0.0);
        let entities = state.parse_entities_parallel().unwrap();
        assert_eq!(
            research_completion_boundary_proof(&state, state.base_value(), &entities, 1.0),
            ResearchCompletionBoundaryProof::CannotCompleteThisStep,
            "the cycle ceiling alone must prove a heavily stocked long research cannot finish"
        );

        let near = research_boundary_fixture(32, 1.0, 99_999.0);
        let near_entities = near.parse_entities_parallel().unwrap();
        assert!(
            research_completion_boundary_proof(&near, near.base_value(), &near_entities, 1.0)
                .requires_full_scan(),
            "a finite boundary possible in this step must select the full oracle"
        );

        let mut queued = near.clone();
        queued.base_value_mut()["research"]["queuedTechIds"] = json!(["mining_speed_1"]);
        assert!(
            research_completion_boundary_proof(&queued, queued.base_value(), &near_entities, 1.0,)
                .requires_full_scan(),
            "automatic queue rollover must retain the full historical row order"
        );

        let mut paused = near.clone();
        paused.base_value_mut()["research"]["selectedTechId"] = Value::Null;
        paused.base_value_mut()["research"]["pausedTechId"] = Value::from("research_speed_1");
        assert_eq!(
            research_completion_boundary_proof(&paused, paused.base_value(), &near_entities, 1.0,),
            ResearchCompletionBoundaryProof::Inactive
        );

        for auto_research in [false, true] {
            let safe = infinite_research_boundary_fixture(32, 249.0, 0, "0", auto_research);
            let safe_entities = safe.parse_entities_parallel().unwrap();
            assert_eq!(
                research_completion_boundary_proof(&safe, safe.base_value(), &safe_entities, 1.0,),
                ResearchCompletionBoundaryProof::CannotCompleteThisStep,
                "cycle ceiling must be safe below the infinite boundary"
            );
            let near_infinite =
                infinite_research_boundary_fixture(32, 1.0, 0, "249", auto_research);
            let near_infinite_entities = near_infinite.parse_entities_parallel().unwrap();
            assert!(
                research_completion_boundary_proof(
                    &near_infinite,
                    near_infinite.base_value(),
                    &near_infinite_entities,
                    1.0,
                )
                .requires_full_scan(),
                "infinite boundary possible auto={auto_research}"
            );
        }

        let mut opaque_entities = near_entities.clone();
        opaque_entities[1]["mod:research-writer"] = json!({ "enabled": true });
        assert!(
            research_completion_boundary_proof(&near, near.base_value(), &opaque_entities, 1.0)
                .requires_full_scan(),
            "opaque research writers must never enter the sparse proof"
        );
    }

    #[test]
    fn duplicate_finite_research_cost_item_forces_full_and_matches_oracle_same_step() {
        let mut indexed = research_boundary_fixture(32, 100.0, 0.0);
        let mut snapshot = indexed.catalog.snapshot.clone();
        let technology = snapshot
            .technologies
            .iter_mut()
            .find(|technology| technology.id == "research_speed_1")
            .unwrap();
        technology.costs = vec![
            ItemAmount {
                item_id: "universe_matrix".to_owned(),
                amount: 100.0,
            },
            ItemAmount {
                item_id: "universe_matrix".to_owned(),
                amount: 100.0,
            },
        ];
        indexed.catalog = std::sync::Arc::new(
            RuntimeCatalog::validate(
                snapshot,
                crate::command::EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT,
            )
            .unwrap(),
        );
        let lab_index = *indexed.entity_index.get("research-boundary-lab").unwrap();
        let mut lab = indexed.parse_entity(lab_index).unwrap();
        lab["machineCount"] = Value::from(100);
        indexed.replace_entity_raw(lab_index, serde_json::to_string(&lab).unwrap().into());
        indexed.rebuild_indexes().unwrap();

        let entities = indexed.parse_entities_parallel().unwrap();
        let maximum_cycles =
            maximum_research_cycles_this_step(&indexed, indexed.base_value(), &entities, 1.0)
                .unwrap();
        assert!(
            (100..200).contains(&maximum_cycles),
            "the cycle ceiling must sit between the shared-item requirement and the invalid per-row sum: {maximum_cycles}"
        );
        assert_eq!(
            research_completion_boundary_proof(&indexed, indexed.base_value(), &entities, 1.0,),
            ResearchCompletionBoundaryProof::RequiresFullScan("finite-duplicate-cost-item")
        );

        let mut oracle = indexed.clone();
        install_forced_ordinary_oracle(&mut oracle);
        let indexed_scans = advance_and_install_ordinary_test_state(&mut indexed, 1.0);
        let oracle_scans = advance_and_install_ordinary_test_state(&mut oracle, 1.0);
        assert!(indexed_scans[0].full_scan && oracle_scans[0].full_scan);
        assert_eq!(
            serde_json::to_vec(&indexed.materialize().unwrap()).unwrap(),
            serde_json::to_vec(&oracle.materialize().unwrap()).unwrap()
        );
        assert_eq!(
            (
                indexed.canonical_sha256().unwrap(),
                indexed.domain_sha256().unwrap(),
                synthetic_conservation_sha256(&indexed),
            ),
            (
                oracle.canonical_sha256().unwrap(),
                oracle.domain_sha256().unwrap(),
                synthetic_conservation_sha256(&oracle),
            )
        );
        assert!(
            indexed.base_value()["research"]["completedTechIds"]
                .as_array()
                .unwrap()
                .iter()
                .any(|technology_id| technology_id == "research_speed_1"),
            "the shared 100 matrices complete both duplicate rows in this step"
        );
    }

    #[test]
    fn research_completion_before_later_machine_matches_force_full_and_changes_same_step_speed() {
        let mut indexed = infinite_research_boundary_fixture(32, 1.0, 0, "249", false);
        let later_index = *indexed
            .entity_index
            .get("ordinary-oactive-machine-50000")
            .unwrap();
        let mut later = indexed.parse_entity(later_index).unwrap();
        later["machineCount"] = Value::from(100);
        later["inputs"]["iron_ore"] = Value::from(1_000);
        later["outputs"]["iron_ingot"] = Value::from(0);
        indexed.replace_entity_raw(later_index, serde_json::to_string(&later).unwrap().into());
        indexed.rebuild_indexes().unwrap();
        let mut oracle = indexed.clone();
        install_forced_ordinary_oracle(&mut oracle);
        let indexed_scans = advance_and_install_ordinary_test_state(&mut indexed, 1.0);
        let oracle_scans = advance_and_install_ordinary_test_state(&mut oracle, 1.0);
        assert_eq!(
            serde_json::to_vec(&indexed.materialize().unwrap()).unwrap(),
            serde_json::to_vec(&oracle.materialize().unwrap()).unwrap()
        );
        assert_eq!(
            (
                indexed.canonical_sha256().unwrap(),
                indexed.domain_sha256().unwrap(),
                synthetic_conservation_sha256(&indexed),
            ),
            (
                oracle.canonical_sha256().unwrap(),
                oracle.domain_sha256().unwrap(),
                synthetic_conservation_sha256(&oracle),
            )
        );
        assert!(indexed_scans[0].full_scan && oracle_scans[0].full_scan);
        assert_eq!(
            indexed.base_value()["endgame"]["infiniteResearch"]["matrix_compression"]["level"],
            json!(1)
        );
        let later = indexed
            .parse_entities_parallel()
            .unwrap()
            .into_iter()
            .find(|entity| entity["id"] == "ordinary-oactive-machine-50000")
            .unwrap();
        assert_eq!(
            later["outputs"]["iron_ingot"],
            json!(104.0),
            "the post-boundary row must use matrix-compression level 1 in the same step"
        );
    }

    #[test]
    fn real_belt_frees_sleeping_producer_output_then_wakes_it_across_multiple_steps() {
        let mut indexed = ordinary_belt_wake_fixture();
        let mut oracle = indexed.clone();
        install_forced_ordinary_oracle(&mut oracle);
        let indexed_scans = advance_and_install_ordinary_test_state(&mut indexed, 5.0);
        let oracle_scans = advance_and_install_ordinary_test_state(&mut oracle, 5.0);
        assert_eq!(
            serde_json::to_vec(&indexed.materialize().unwrap()).unwrap(),
            serde_json::to_vec(&oracle.materialize().unwrap()).unwrap(),
            "a real late belt capacity change must wake the sleeping producer before its next settlement"
        );
        assert_eq!(
            (
                indexed.canonical_sha256().unwrap(),
                indexed.domain_sha256().unwrap(),
                synthetic_conservation_sha256(&indexed),
            ),
            (
                oracle.canonical_sha256().unwrap(),
                oracle.domain_sha256().unwrap(),
                synthetic_conservation_sha256(&oracle),
            )
        );
        assert_eq!(indexed_scans.len(), 5);
        assert_eq!(indexed_scans[0].selected_rows, 33);
        assert!(indexed_scans[0].full_scan);
        eprintln!("REAL_BELT_WAKE_EVIDENCE scans={indexed_scans:?}");
        assert!(
            indexed_scans
                .iter()
                .skip(1)
                .all(|scan| !scan.full_scan && scan.selected_rows == 1),
            "the producer must be selected by real belt movement without waking 32 dormant siblings: {indexed_scans:?}"
        );
        assert!(oracle_scans.iter().all(|scan| scan.full_scan));
        let producer = indexed
            .parse_entities_parallel()
            .unwrap()
            .into_iter()
            .find(|entity| entity["id"] == "belt-wake-producer")
            .unwrap();
        assert!(
            finite_number(
                producer
                    .get("outputs")
                    .and_then(|outputs| outputs.get("iron_ingot"))
            ) < 100.0,
            "the belt must have moved real producer output"
        );
        assert!(
            finite_number(
                indexed
                    .base_value()
                    .get("totalProduced")
                    .and_then(|total| total.get("iron_ingot"))
            ) > 0.0,
            "the belt-woken producer must resume production"
        );
    }

    #[test]
    fn ordinary_oactive_power_loss_fuel_restore_and_input_output_depletion_match_oracle() {
        let mut indexed = ordinary_oactive_fixture(PARALLEL_MIN_ITEMS + 17);
        let mut oracle = indexed.clone();
        replace_thermal_fuel(&mut indexed, 0.0);
        replace_thermal_fuel(&mut oracle, 0.0);
        install_forced_ordinary_oracle(&mut oracle);

        let indexed_loss_scans = advance_and_install_ordinary_test_state(&mut indexed, 3.0);
        let oracle_loss_scans = advance_and_install_ordinary_test_state(&mut oracle, 3.0);
        assert_eq!(
            indexed.materialize().unwrap(),
            oracle.materialize().unwrap()
        );
        assert!(
            indexed_loss_scans
                .iter()
                .skip(1)
                .all(|scan| !scan.full_scan)
        );
        assert!(oracle_loss_scans.iter().all(|scan| scan.full_scan));

        replace_thermal_fuel(&mut indexed, 5.0);
        replace_thermal_fuel(&mut oracle, 5.0);
        install_forced_ordinary_oracle(&mut oracle);
        let indexed_restore_scans = advance_and_install_ordinary_test_state(&mut indexed, 5.0);
        let oracle_restore_scans = advance_and_install_ordinary_test_state(&mut oracle, 5.0);
        assert_eq!(
            indexed.materialize().unwrap(),
            oracle.materialize().unwrap()
        );
        assert_eq!(
            indexed.canonical_sha256().unwrap(),
            oracle.canonical_sha256().unwrap()
        );
        assert_eq!(
            indexed.domain_sha256().unwrap(),
            oracle.domain_sha256().unwrap()
        );
        assert_eq!(
            synthetic_conservation_sha256(&indexed),
            synthetic_conservation_sha256(&oracle)
        );
        assert!(
            indexed_restore_scans
                .iter()
                .skip(1)
                .all(|scan| !scan.full_scan)
        );
        assert!(oracle_restore_scans.iter().all(|scan| scan.full_scan));

        let materialized = indexed.materialize().unwrap();
        let entities = materialized["entities"].as_array().unwrap();
        let by_id = |id: &str| {
            entities
                .iter()
                .find(|entity| entity["id"].as_str() == Some(id))
                .unwrap()
        };
        assert_eq!(
            by_id("ordinary-oactive-full-miner")["outputs"]["iron_ore"],
            json!(100.0)
        );
        assert_eq!(
            by_id("ordinary-oactive-depleted-miner")["resourceRemaining"],
            json!(0.0)
        );
        assert_eq!(
            by_id("ordinary-oactive-machine-00001")["outputs"]["iron_ingot"],
            json!(100.0)
        );
        assert!(
            by_id("ordinary-oactive-machine-00000")["outputs"]["iron_ingot"]
                .as_f64()
                .unwrap()
                > 0.0,
            "fuel restoration must resume the still-active producer"
        );
    }

    #[test]
    fn ordinary_oactive_quiesces_after_last_input_full_output_and_miner_terminal_passes() {
        for seconds in [1.0, 2.0, 3.0] {
            let mut indexed = ordinary_oactive_quiesce_fixture();
            let mut oracle = indexed.clone();
            install_forced_ordinary_oracle(&mut oracle);
            let indexed_scans = advance_and_install_ordinary_test_state(&mut indexed, seconds);
            let oracle_scans = advance_and_install_ordinary_test_state(&mut oracle, seconds);
            assert_eq!(
                serde_json::to_vec(&indexed.materialize().unwrap()).unwrap(),
                serde_json::to_vec(&oracle.materialize().unwrap()).unwrap(),
                "ordinary quiesce bytes diverged at {seconds}s"
            );
            assert_eq!(
                (
                    indexed.canonical_sha256().unwrap(),
                    indexed.domain_sha256().unwrap(),
                    synthetic_conservation_sha256(&indexed),
                ),
                (
                    oracle.canonical_sha256().unwrap(),
                    oracle.domain_sha256().unwrap(),
                    synthetic_conservation_sha256(&oracle),
                ),
                "ordinary quiesce hashes diverged at {seconds}s"
            );
            assert!(oracle_scans.iter().all(|scan| scan.full_scan));
            assert_eq!(indexed_scans[0].selected_rows, 24);
            if seconds >= 2.0 {
                assert_eq!(
                    indexed_scans[1].selected_rows, 4,
                    "the post-production normalization pass must stay awake"
                );
                assert!(!indexed_scans[1].full_scan);
            }
            if seconds >= 3.0 {
                assert_eq!(
                    indexed_scans[2].selected_rows, 1,
                    "only the legacy power-demand-active depleted vein remains awake"
                );
                assert!(!indexed_scans[2].full_scan);
            }

            let materialized = indexed.materialize().unwrap();
            let entities = materialized["entities"].as_array().unwrap();
            let by_id = |id: &str| {
                entities
                    .iter()
                    .find(|entity| entity["id"].as_str() == Some(id))
                    .unwrap()
            };
            assert_eq!(
                by_id("ordinary-oactive-last-input")["inputs"]["iron_ore"],
                json!(0.0)
            );
            assert_eq!(
                by_id("ordinary-oactive-filled-machine")["outputs"]["iron_ingot"],
                json!(100.0)
            );
            assert_eq!(
                by_id("ordinary-oactive-exhausted-vein")["resourceRemaining"],
                json!(0.0)
            );
            assert_eq!(
                by_id("ordinary-oactive-filled-vein")["outputs"]["iron_ore"],
                json!(100.0)
            );
            for id in [
                "ordinary-oactive-last-input",
                "ordinary-oactive-filled-machine",
                "ordinary-oactive-exhausted-vein",
                "ordinary-oactive-filled-vein",
            ] {
                let row = by_id(id);
                if seconds == 1.0 {
                    assert!(finite_number(row.get("productionRate")) > 0.0);
                } else {
                    assert_eq!(row["utilization"], json!(0.0), "{id} at {seconds}s");
                    assert_eq!(row["productionRate"], json!(0.0), "{id} at {seconds}s");
                }
            }
        }
    }

    #[test]
    fn failed_ordinary_oactive_candidate_retains_source_wakes_and_bytes() {
        let mut state = ordinary_oactive_fixture(PARALLEL_MIN_ITEMS + 9);
        state.base_value_mut().remove("totalProduced");
        let source_bytes = serde_json::to_vec(&state.materialize().unwrap()).unwrap();
        let source_runtime = state
            .prepared_ordinary_production_runtime()
            .expect("source production runtime");
        let pending = source_runtime.pending_rows_for_test();
        let history = source_runtime.scan_history_for_test().to_vec();
        let error = prepare_advance_with_runtime(
            &state,
            1.0,
            1.0,
            false,
            &DeterministicRuntime::for_test(4),
        )
        .err()
        .expect("malformed totalProduced must fail");
        assert!(format!("{error:#}").contains("total production record is missing"));
        assert_eq!(
            serde_json::to_vec(&state.materialize().unwrap()).unwrap(),
            source_bytes
        );
        let retained = state
            .prepared_ordinary_production_runtime()
            .expect("retained production runtime");
        assert!(std::sync::Arc::ptr_eq(&source_runtime, &retained));
        assert_eq!(retained.pending_rows_for_test(), pending);
        assert_eq!(retained.scan_history_for_test(), history);
    }

    #[test]
    fn ordinary_oactive_quiet_1024_dense_mod_identity_and_failed_candidate_are_fail_closed() {
        let entities = (0..1_024)
            .map(|index| ordinary_oactive_machine(index, 0.0, 0.0))
            .collect::<Vec<_>>();
        let state = fixture_state_from_base_with_registry(
            construction_isolation_base(),
            &entities,
            crate::command::EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT,
        );
        let mut runtime =
            crate::ordinary_production::OrdinaryProductionRuntime::build(&state, &entities);
        let cold = runtime.select(&state, &entities, false);
        assert_eq!(cold.scan.selected_rows, 1_024);
        let cold_rows = cold.selected_supported_machine_indices.clone();
        runtime
            .commit_selection(
                cold,
                &cold_rows
                    .into_iter()
                    .map(|index| (index, false))
                    .collect::<Vec<_>>(),
                &[],
            )
            .unwrap();
        let quiet = runtime.select(&state, &entities, false);
        assert_eq!(quiet.scan.selected_rows, 0);
        assert_eq!(quiet.scan.stable_rows_skipped, 1_024);
        let technology_barrier = runtime.select(&state, &entities, true);
        assert_eq!(technology_barrier.scan.selected_rows, 1_024);
        assert!(technology_barrier.scan.full_scan);

        runtime.wake_from_changed_entities(&[511]);
        let one = runtime.select(&state, &entities, false);
        assert_eq!(one.scan.selected_rows, 1);
        assert_eq!(one.scan.stable_rows_skipped, 1_023);
        runtime.commit_selection(one, &[(511, false)], &[]).unwrap();
        runtime.wake_from_output_credits(&[(700, 0)]);
        let credit_wake = runtime.select(&state, &entities, false);
        assert_eq!(credit_wake.machine_indices, vec![700]);
        runtime
            .commit_selection(credit_wake, &[(700, false)], &[])
            .unwrap();

        runtime.wake_from_changed_entities(&(0..768).collect::<Vec<_>>());
        let dense = runtime.select(&state, &entities, false);
        assert_eq!(dense.scan.selected_rows, 1_024);
        assert!(dense.scan.dense_fallback && dense.scan.full_scan);

        let mut mod_state = state.clone();
        mod_state.identity.registry_fingerprint = "mod:opaque-writer".to_owned();
        let mod_runtime =
            crate::ordinary_production::OrdinaryProductionRuntime::build(&mod_state, &entities);
        let mod_scan = mod_runtime.select(&mod_state, &entities, false).scan;
        assert!(mod_scan.directory_fallback && mod_scan.full_scan);

        let mut rebuilt_topology = state.clone();
        std::sync::Arc::make_mut(&mut rebuilt_topology.factory_topology)
            .ordinary_machine_indices
            .shrink_to_fit();
        let rebuilt_scan = runtime.select(&rebuilt_topology, &entities, false).scan;
        assert!(rebuilt_scan.directory_fallback && rebuilt_scan.full_scan);

        let mut drifted_entities = entities.clone();
        let mut drift_runtime =
            crate::ordinary_production::OrdinaryProductionRuntime::build(&state, &drifted_entities);
        let first = drift_runtime.select(&state, &drifted_entities, false);
        let first_rows = first.selected_supported_machine_indices.clone();
        drift_runtime
            .commit_selection(
                first,
                &first_rows
                    .into_iter()
                    .map(|index| (index, false))
                    .collect::<Vec<_>>(),
                &[],
            )
            .unwrap();
        drifted_entities[17]["id"] = Value::from("identity-drift");
        drift_runtime.wake_from_changed_entities(&[17]);
        let drift = drift_runtime.select(&state, &drifted_entities, false);
        assert!(drift.scan.directory_fallback && drift.scan.full_scan);

        let mut failed =
            crate::ordinary_production::OrdinaryProductionRuntime::build(&state, &entities);
        let initial = failed.select(&state, &entities, false);
        let initial_rows = initial.selected_supported_machine_indices.clone();
        failed
            .commit_selection(
                initial,
                &initial_rows
                    .into_iter()
                    .map(|index| (index, false))
                    .collect::<Vec<_>>(),
                &[],
            )
            .unwrap();
        failed.wake_from_changed_entities(&[23]);
        let failed_selection = failed.select(&state, &entities, false);
        let error = failed
            .commit_selection(failed_selection, &[], &[])
            .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("machine readiness order diverged")
        );
        assert_eq!(failed.pending_rows_for_test().0, vec![23]);
    }

    fn ordinary_random_ready(entity: &Value) -> bool {
        finite_number(
            entity
                .get("inputs")
                .and_then(|inputs| inputs.get("iron_ore")),
        ) >= 1.0
            && finite_number(
                entity
                    .get("outputs")
                    .and_then(|outputs| outputs.get("iron_ingot")),
            ) < 100.0
    }

    fn settle_ordinary_random_rows(entities: &mut [Value], indices: &[usize]) {
        for &index in indices {
            if !ordinary_random_ready(&entities[index]) {
                continue;
            }
            let object = entities[index].as_object_mut().unwrap();
            let input = finite_number(
                object
                    .get("inputs")
                    .and_then(|inputs| inputs.get("iron_ore")),
            );
            let output = finite_number(
                object
                    .get("outputs")
                    .and_then(|outputs| outputs.get("iron_ingot")),
            );
            object["inputs"]["iron_ore"] = Value::from((input - 1.0).max(0.0));
            object["outputs"]["iron_ingot"] = Value::from(output + 1.0);
        }
    }

    fn replay_ordinary_random_events(
        seed: u64,
    ) -> (
        Vec<u8>,
        Vec<crate::ordinary_production::OrdinaryProductionScan>,
    ) {
        let source = (0..257)
            .map(|index| ordinary_oactive_machine(index, 0.0, 0.0))
            .collect::<Vec<_>>();
        let state = fixture_state_from_base_with_registry(
            construction_isolation_base(),
            &source,
            crate::command::EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT,
        );
        let mut indexed_entities = source.clone();
        let mut oracle_entities = source;
        let mut indexed =
            crate::ordinary_production::OrdinaryProductionRuntime::build(&state, &indexed_entities);
        let mut oracle =
            crate::ordinary_production::OrdinaryProductionRuntime::build(&state, &oracle_entities);
        oracle.force_full_scan_for_test(true);
        let mut random = seed;
        for step in 0..120 {
            random ^= random << 13;
            random ^= random >> 7;
            random ^= random << 17;
            let event_count = (random as usize % 3) + 1;
            let mut changed = Vec::with_capacity(event_count);
            for event in 0..event_count {
                random = random
                    .wrapping_mul(6_364_136_223_846_793_005)
                    .wrapping_add(1 + event as u64);
                let index = random as usize % indexed_entities.len();
                let amount = ((random >> 11) % 113) as f64;
                let key = if random & 1 == 0 {
                    ("inputs", "iron_ore")
                } else {
                    ("outputs", "iron_ingot")
                };
                indexed_entities[index][key.0][key.1] = Value::from(amount);
                oracle_entities[index][key.0][key.1] = Value::from(amount);
                changed.push(index);
            }
            indexed.wake_from_changed_entities(&changed);
            oracle.wake_from_changed_entities(&changed);
            let indexed_selection = indexed.select(&state, &indexed_entities, false);
            let oracle_selection = oracle.select(&state, &oracle_entities, false);
            let indexed_pre_readiness = indexed_selection
                .selected_supported_machine_indices
                .iter()
                .map(|&index| (index, ordinary_random_ready(&indexed_entities[index])))
                .collect::<Vec<_>>();
            let oracle_pre_readiness = oracle_selection
                .selected_supported_machine_indices
                .iter()
                .map(|&index| (index, ordinary_random_ready(&oracle_entities[index])))
                .collect::<Vec<_>>();
            settle_ordinary_random_rows(&mut indexed_entities, &indexed_selection.machine_indices);
            settle_ordinary_random_rows(&mut oracle_entities, &oracle_selection.machine_indices);
            let indexed_readiness = indexed_selection
                .selected_supported_machine_indices
                .iter()
                .zip(indexed_pre_readiness.iter())
                .map(|(&index, &(_, pre_ready))| {
                    (
                        index,
                        pre_ready || ordinary_random_ready(&indexed_entities[index]),
                    )
                })
                .collect::<Vec<_>>();
            let oracle_readiness = oracle_selection
                .selected_supported_machine_indices
                .iter()
                .zip(oracle_pre_readiness.iter())
                .map(|(&index, &(_, pre_ready))| {
                    (
                        index,
                        pre_ready || ordinary_random_ready(&oracle_entities[index]),
                    )
                })
                .collect::<Vec<_>>();
            indexed
                .commit_selection(indexed_selection, &indexed_readiness, &[])
                .unwrap();
            oracle
                .commit_selection(oracle_selection, &oracle_readiness, &[])
                .unwrap();
            assert_eq!(
                serde_json::to_vec(&indexed_entities).unwrap(),
                serde_json::to_vec(&oracle_entities).unwrap(),
                "random ordinary production diverged at step {} seed {seed}",
                step + 1
            );
        }
        (
            serde_json::to_vec(&indexed_entities).unwrap(),
            indexed.scan_history_for_test().to_vec(),
        )
    }

    #[test]
    fn ordinary_oactive_randomized_event_sequences_are_byte_exact_and_repeatable() {
        for seed in [1, 2, 3, 0xdead_beef, u64::MAX - 1] {
            let first = replay_ordinary_random_events(seed);
            let second = replay_ordinary_random_events(seed);
            assert_eq!(first, second, "random replay changed at seed {seed}");
            assert!(first.1.iter().skip(1).any(|scan| !scan.full_scan));
            let digest: [u8; 32] = sha2::Sha256::digest(&first.0).into();
            let repeated: [u8; 32] = sha2::Sha256::digest(&second.0).into();
            assert_eq!(
                digest, repeated,
                "random replay hash changed at seed {seed}"
            );
        }
    }

    fn run_partitioned_factory_advance(
        worker_count: usize,
    ) -> (
        PartitionedPrepareDiagnostics,
        String,
        String,
        String,
        Vec<u8>,
    ) {
        let runtime = DeterministicRuntime::for_test(worker_count);
        let mut state = partitioned_factory_fixture();
        let source_revision = state.revision;
        let source_hash = state.canonical_sha256().unwrap();
        let source_bytes = serde_json::to_vec(&state.materialize().unwrap()).unwrap();
        state.clear_prepared_factory_domains_for_test();
        assert_prepared_factory_domains_are_clear(&state);
        let entities = state.parse_entities_parallel().unwrap();
        let domains =
            prepare_factory_domains_with_runtime(&state, state.base_value(), &entities, &runtime)
                .unwrap();
        let scheduler = domains.scheduler;
        drop(domains);
        assert_eq!(state.revision, source_revision);
        assert_eq!(state.canonical_sha256().unwrap(), source_hash);
        assert_eq!(
            serde_json::to_vec(&state.materialize().unwrap()).unwrap(),
            source_bytes,
            "read-only domain preparation must not publish a partial candidate"
        );
        assert_prepared_factory_domains_are_clear(&state);

        let prepared = prepare_advance_with_runtime(&state, 1.0, 1.0, false, &runtime).unwrap();
        let next_revision = source_revision + 1;
        state
            .commit_simulated_state(
                prepared.base,
                prepared.entities,
                prepared.belt_commit,
                next_revision,
                false,
            )
            .unwrap();
        assert_eq!(state.revision, next_revision);
        (
            scheduler,
            state.canonical_sha256().unwrap(),
            state.domain_sha256().unwrap(),
            synthetic_conservation_sha256(&state),
            serde_json::to_vec(&state.materialize().unwrap()).unwrap(),
        )
    }

    #[test]
    fn partitioned_factory_prepare_and_commit_are_byte_exact_at_one_two_four_eight_workers() {
        let expected = run_partitioned_factory_advance(1);
        assert_eq!(expected.0.active_partitions, 8);
        assert!(!expected.0.parallel);
        assert_eq!(expected.0.selected_worker_count, 1);
        for worker_count in [2, 4, 8] {
            let observed = run_partitioned_factory_advance(worker_count);
            assert_eq!(observed.0.active_partitions, 8);
            assert!(observed.0.parallel);
            assert_eq!(observed.0.selected_worker_count, worker_count);
            assert!((1..=worker_count).contains(&observed.0.observed_worker_count));
            assert_eq!(
                (&observed.1, &observed.2, &observed.3, &observed.4),
                (&expected.1, &expected.2, &expected.3, &expected.4),
                "authoritative bytes, canonical, domain or conservation hashes diverged at {worker_count} workers"
            );
        }
        let repeated = run_partitioned_factory_advance(8);
        assert_eq!(
            (&repeated.1, &repeated.2, &repeated.3, &repeated.4),
            (&expected.1, &expected.2, &expected.3, &expected.4),
            "the same eight-worker schedule must remain repeatable"
        );
    }

    #[test]
    fn failed_partitioned_factory_prepare_is_atomic_at_every_worker_limit() {
        for worker_count in [1, 2, 4, 8] {
            let mut state = partitioned_factory_fixture();
            let source_revision = state.revision;
            let source_hash = state.canonical_sha256().unwrap();
            let source_bytes = serde_json::to_vec(&state.materialize().unwrap()).unwrap();
            state.clear_prepared_factory_domains_for_test();
            assert_prepared_factory_domains_are_clear(&state);
            let mut malformed_entities = state.parse_entities_parallel().unwrap();
            malformed_entities.push(Value::Null);
            let malformed_bytes = serde_json::to_vec(&malformed_entities).unwrap();
            let failure = match prepare_factory_domains_with_runtime(
                &state,
                state.base_value(),
                &malformed_entities,
                &DeterministicRuntime::for_test(worker_count),
            ) {
                Ok(_) => panic!("malformed domain preparation unexpectedly succeeded"),
                Err(failure) => failure,
            };
            assert_eq!(
                failure.to_string(),
                "native belt route entity topology changed",
                "worker count {worker_count}"
            );
            assert_eq!(state.revision, source_revision);
            assert_eq!(state.canonical_sha256().unwrap(), source_hash);
            assert_eq!(
                serde_json::to_vec(&state.materialize().unwrap()).unwrap(),
                source_bytes
            );
            assert_eq!(
                serde_json::to_vec(&malformed_entities).unwrap(),
                malformed_bytes
            );
            assert_prepared_factory_domains_are_clear(&state);
        }
    }

    #[test]
    fn failed_later_partition_never_publishes_an_earlier_successful_cache() {
        for worker_count in [1, 2, 4, 8] {
            let mut state = partitioned_factory_fixture();
            state.clear_prepared_factory_domains_for_test();
            let station_index = 1;
            std::sync::Arc::make_mut(&mut state.factory_topology).station_indices =
                vec![station_index];
            let mut malformed_entities = state.parse_entities_parallel().unwrap();
            malformed_entities[station_index] = json!({
                "id": "partitioned-malformed-station",
                "kind": "station",
                "planetId": "home",
                "powerGridId": "grid-a",
                "buildingId": "planetary_logistics_station",
                "machineCount": 1
            });
            let source_revision = state.revision;
            let source_hash = state.canonical_sha256().unwrap();
            let source_bytes = serde_json::to_vec(&state.materialize().unwrap()).unwrap();

            let failure = match prepare_factory_domains_with_runtime(
                &state,
                state.base_value(),
                &malformed_entities,
                &DeterministicRuntime::for_test(worker_count),
            ) {
                Ok(_) => panic!("later partition failure unexpectedly committed"),
                Err(failure) => failure,
            };
            assert_eq!(
                failure.to_string(),
                "native local station slots are missing"
            );
            assert_eq!(state.revision, source_revision);
            assert_eq!(state.canonical_sha256().unwrap(), source_hash);
            assert_eq!(
                serde_json::to_vec(&state.materialize().unwrap()).unwrap(),
                source_bytes
            );
            assert_prepared_factory_domains_are_clear(&state);
        }
    }

    #[test]
    fn parallel_power_demand_failures_join_then_keep_domain_and_row_priority() {
        let state = partitioned_factory_fixture();
        let state_hash = state.canonical_sha256().unwrap();
        let mut entities = state.parse_entities_parallel().unwrap();
        let first_failure = state.factory_topology.ordinary_machine_indices[17];
        let later_failure = state.factory_topology.ordinary_machine_indices[PARALLEL_MIN_ITEMS + 7];
        entities[first_failure]
            .as_object_mut()
            .unwrap()
            .remove("buildingId");
        entities[later_failure]
            .as_object_mut()
            .unwrap()
            .remove("buildingId");
        let entity_bytes = serde_json::to_vec(&entities).unwrap();
        let ready_indices = state.factory_topology.ordinary_machine_indices.clone();
        let profiles = [fixture_profile()];
        for worker_count in [1, 2, 4, 8] {
            let prepared = prepare_power_demand_probes_with_runtime(
                &DeterministicRuntime::for_test(worker_count),
                &state,
                state.base_value(),
                &entities,
                &profiles,
                &ready_indices,
                &state.factory_topology.vein_indices,
                &state.factory_topology.ordinary_machine_indices,
                DEFAULT_BUILDING_BUFFER_LIMIT,
                1.0,
                1.0,
                1.0,
                1.0,
            );
            assert_eq!(prepared.scheduler.active_partitions, 3);
            assert_eq!(prepared.scheduler.parallel, worker_count != 1);
            assert_eq!(prepared.ready_stations.len(), ready_indices.len());
            assert_eq!(
                prepared
                    .ready_stations
                    .into_iter()
                    .collect::<anyhow::Result<Vec<_>>>()
                    .unwrap_err()
                    .to_string(),
                "native local station building is missing"
            );
            assert_eq!(
                prepared
                    .machines
                    .into_iter()
                    .collect::<anyhow::Result<Vec<_>>>()
                    .unwrap_err()
                    .to_string(),
                "native simple factory machine building is missing"
            );
            assert_eq!(
                prepared.veins.len(),
                state.factory_topology.vein_indices.len()
            );
            assert!(prepared.veins.into_iter().all(|result| result.is_ok()));
            assert_eq!(serde_json::to_vec(&entities).unwrap(), entity_bytes);
            assert_eq!(state.canonical_sha256().unwrap(), state_hash);
        }
    }

    fn fixture_profile() -> PlanetProfile {
        PlanetProfile {
            wind_multiplier: 1.0,
            solar_power_multiplier: 1.0,
            geothermal_multiplier: 1.0,
            mining_multiplier: 1.0,
            production_speed_multiplier: 1.0,
            specialization: "",
            ocean_type: "none",
        }
    }

    fn local_machine_matrix(count: usize) -> Vec<Value> {
        (0..count)
            .map(|index| {
                let recipe_id = if index % 8 == 4 {
                    "locked_ingot"
                } else {
                    "iron_ingot"
                };
                let mut entity =
                    machine_entity(format!("machine-{index:05}"), "arc_smelter", recipe_id);
                match index % 8 {
                    0 => {
                        entity["sprayCoaterInstalled"] = Value::from(true);
                        entity["proliferatorTier"] = Value::from(1);
                        entity["proliferatorMode"] = Value::from("extra");
                        entity["proliferatorPoints"] = Value::from(4);
                    }
                    1 => {
                        entity["sprayCoaterInstalled"] = Value::from(true);
                        entity["proliferatorTier"] = Value::from(1);
                        entity["proliferatorMode"] = Value::from("speed");
                        entity["proliferatorPoints"] = Value::from(4);
                    }
                    2 => entity["outputs"]["iron_ingot"] = Value::from(100),
                    _ => {}
                }
                entity
            })
            .collect()
    }

    fn matrix_power_factors(count: usize) -> HashMap<usize, f64> {
        (0..count)
            .filter_map(|index| match index % 8 {
                3 => Some((index, 0.0)),
                6 => Some((index, 0.5)),
                _ => None,
            })
            .collect()
    }

    fn vein_entity(index: usize) -> Value {
        let mut entity = json!({
            "id": format!("mod:矿点/{index:05}/Ω🚀"),
            "kind": "vein",
            "planetId": "home",
            "powerGridId": "grid-a",
            "buildingId": "mining_machine",
            "recipeId": null,
            "machineCount": 1,
            "minerCount": 1 + index % 3,
            "resourceId": "iron_ore",
            "resourceRemaining": 1000 + index % 17,
            "resourceDepletionRemainder": index % 10,
            "outputs": { "iron_ore": index % 7 },
            "progress": (index % 13) as f64 / 13.0,
            "utilization": -1,
            "productionRate": -1,
            "mod:vein/opaque": {
                "index": index,
                "signedZero": -0.0,
                "text": "保持原样"
            }
        });
        match index % 19 {
            0 => entity["minerCount"] = Value::from(0),
            1 => entity["outputs"]["iron_ore"] = Value::from(100),
            2 => entity["resourceRemaining"] = Value::from(0),
            _ => {}
        }
        entity
    }

    fn vein_matrix(count: usize) -> Vec<Value> {
        (0..count).map(vein_entity).collect()
    }

    fn vein_power_factors(count: usize) -> HashMap<usize, f64> {
        (0..count)
            .filter_map(|index| match index % 11 {
                3 => Some((index, 0.0)),
                7 => Some((index, 0.5)),
                _ => None,
            })
            .collect()
    }

    fn renewable_power_entity(index: usize) -> Value {
        let building_id = match index % 3 {
            0 => "wind_turbine",
            1 => "solar_panel",
            _ => "geothermal_power_station",
        };
        json!({
            "id": format!("renewable-{index:05}"),
            "kind": "power",
            "planetId": "home",
            "powerGridId": "grid-a",
            "buildingId": building_id,
            "machineCount": 1 + index % 11,
            "minerCount": 0,
            "inputs": {},
            "outputs": {},
            "progress": 0,
            "utilization": -1,
            "productionRate": -1,
            "powerOutputKw": -1,
            "powerInputKw": -1,
            "routingCursor": 0,
            "mod:renewable/private": { "index": index, "signedZero": -0.0 }
        })
    }

    fn renewable_power_matrix(count: usize) -> Vec<Value> {
        (0..count).map(renewable_power_entity).collect()
    }

    fn clean_renewable_power_entity(index: usize) -> Value {
        let building_id = match index % 3 {
            0 => "wind_turbine",
            1 => "solar_panel",
            _ => "geothermal_power_station",
        };
        json!({
            "id": format!("power-probe-renewable-{index:05}"),
            "kind": "power",
            "planetId": "home",
            "powerGridId": "grid-a",
            "buildingId": building_id,
            "machineCount": 1 + index % 7,
            "minerCount": 0,
            "inputs": {},
            "outputs": {},
            "progress": 0,
            "utilization": 0,
            "productionRate": 0,
            "powerOutputKw": 0,
            "powerInputKw": 0,
            "routingCursor": 0
        })
    }

    fn power_probe_thermal_entity(index: usize) -> Value {
        json!({
            "id": format!("power-probe-thermal-{index:05}"),
            "kind": "power",
            "planetId": "home",
            "powerGridId": "grid-a",
            "buildingId": "thermal_power_plant",
            "machineCount": 1 + index % 3,
            "minerCount": 0,
            "fuelItemId": "coal",
            "fuelRemainingMj": (index % 2) as f64 * 0.75,
            "inputs": { "coal": 10 + index },
            "outputs": {},
            "progress": 0,
            "utilization": 0,
            "productionRate": 0,
            "powerOutputKw": 0,
            "powerInputKw": 0,
            "routingCursor": 0
        })
    }

    fn power_probe_oactive_fixture(renewable_count: usize, thermal_count: usize) -> CoreState {
        let mut entities = (0..renewable_count)
            .map(clean_renewable_power_entity)
            .collect::<Vec<_>>();
        entities.extend((0..thermal_count).map(power_probe_thermal_entity));
        fixture_state_from_base_with_registry(
            construction_isolation_base(),
            &entities,
            crate::command::EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT,
        )
    }

    #[derive(Debug)]
    struct PowerProbeRun {
        bytes: Vec<u8>,
        canonical: String,
        domain: String,
        scans: Vec<PowerProbeScan>,
    }

    fn run_power_probe_advance(
        mut state: CoreState,
        seconds: f64,
        worker_count: usize,
        mode: PowerProbeMode,
    ) -> PowerProbeRun {
        let prepared = prepare_advance_with_power_probe_test_options(
            &state,
            seconds,
            seconds,
            false,
            &DeterministicRuntime::for_test(worker_count),
            mode,
            Some(1.0),
        )
        .unwrap();
        let scans = prepared
            .power_probe_runtime
            .scan_history_for_test()
            .to_vec();
        commit_and_install_factory_test_state(&mut state, prepared);
        PowerProbeRun {
            bytes: serde_json::to_vec(&state.materialize().unwrap()).unwrap(),
            canonical: state.canonical_sha256().unwrap(),
            domain: state.domain_sha256().unwrap(),
            scans,
        }
    }

    fn renewable_power_grids(count: usize) -> Vec<GridRuntime> {
        let mut grids = vec![GridRuntime::default(); GRID_IDS.len()];
        for index in 0..count {
            grids[0]
                .power_output_by_entity
                .insert(index, (index % 997) as f64 + 0.345_678);
            if index % 17 == 0 {
                grids[0]
                    .power_input_by_entity
                    .insert(index, (index % 31) as f64 + 0.125);
            }
        }
        grids
    }

    fn serial_renewable_power_oracle(
        state: &CoreState,
        source: &[Value],
        grids: &[GridRuntime],
    ) -> Vec<Value> {
        let mut entities = source.to_vec();
        for &entity_index in &state.factory_topology.power_source_indices {
            let object = entity_object(&mut entities[entity_index]).unwrap();
            let building_id = state
                .symbols
                .resolve(state.entities.buildings[entity_index])
                .unwrap();
            if !is_independent_renewable_power_facility(building_id) {
                continue;
            }
            let building = state.catalog.buildings.get(building_id).unwrap();
            let output = grids[0]
                .power_output_by_entity
                .get(&entity_index)
                .copied()
                .unwrap_or(0.0);
            let input = grids[0]
                .power_input_by_entity
                .get(&entity_index)
                .copied()
                .unwrap_or(0.0);
            let rated = building.power_generation_kw * finite_number(object.get("machineCount"));
            set_number(object, "powerOutputKw", rounded(output, 2)).unwrap();
            set_number(object, "powerInputKw", rounded(input, 2)).unwrap();
            set_number(
                object,
                "utilization",
                if rated > EPSILON {
                    rounded(output.max(input) / rated, 4)
                } else {
                    0.0
                },
            )
            .unwrap();
            set_number(object, "productionRate", 0.0).unwrap();
        }
        entities
    }

    fn run_renewable_power_patches(
        state: &CoreState,
        source: &[Value],
        grids: &[GridRuntime],
        worker_count: usize,
    ) -> (Vec<Value>, Vec<Option<usize>>) {
        let mut entities = source.to_vec();
        let source_bytes = serde_json::to_vec(&entities).unwrap();
        let patches = collect_renewable_power_facility_patches_with_runtime(
            &DeterministicRuntime::for_test(worker_count),
            state,
            &entities,
            &state.factory_topology.power_source_indices,
            grids,
        )
        .unwrap();
        assert_eq!(
            serde_json::to_vec(&entities).unwrap(),
            source_bytes,
            "renewable worker probes must not mutate source entities",
        );
        let workers = patches.iter().map(|patch| patch.worker_index).collect();
        for patch in patches {
            apply_renewable_power_facility_patch(&mut entities[patch.entity_index], patch).unwrap();
        }
        (entities, workers)
    }

    fn finite_vein_context() -> VeinSettlementContext {
        VeinSettlementContext {
            production_buffer_limit: 100.0,
            mining_research_multiplier: 1.25,
            vein_level: 1.0,
            finite_consumption_tenths: 9.0,
            infinite_resource_mode: false,
            seconds: 1.25,
        }
    }

    fn run_vein_matrix(
        state: &CoreState,
        source: &[Value],
        worker_count: usize,
    ) -> (Vec<Value>, HashMap<String, f64>, Vec<usize>) {
        let runtime = DeterministicRuntime::for_test(worker_count);
        let mut entities = source.to_vec();
        let source_bytes = serde_json::to_vec(&entities).unwrap();
        let profiles = [fixture_profile()];
        let mut grids = vec![GridRuntime::default(); GRID_IDS.len()];
        grids[0].has_power_source = true;
        let power_factors = vein_power_factors(entities.len());
        let output_credits = crate::belts::OutputCredits::default();
        let outcomes = collect_vein_settlement_outcomes(
            &runtime,
            &state.factory_topology.vein_indices,
            &VeinProbeEnvironment {
                state,
                entities: &entities,
                profiles: &profiles,
                grids: &grids,
                power_factors: &power_factors,
                output_credits: &output_credits,
                context: finite_vein_context(),
            },
        );
        assert_eq!(
            serde_json::to_vec(&entities).unwrap(),
            source_bytes,
            "vein probes must not mutate entity or MOD state"
        );
        let outcome_order = outcomes
            .iter()
            .map(|outcome| outcome.entity_index)
            .collect::<Vec<_>>();
        let mut produced = HashMap::new();
        for outcome in outcomes {
            if let Some((item_id, amount)) =
                replay_vein_settlement(&mut entities[outcome.entity_index], outcome.result.unwrap())
                    .unwrap()
            {
                add_produced_item(&mut produced, &item_id, amount);
            }
        }
        (entities, produced, outcome_order)
    }

    fn run_local_machine_matrix(
        state: &CoreState,
        source: &[Value],
        worker_count: usize,
    ) -> (Vec<Value>, HashMap<String, f64>, Vec<usize>) {
        let runtime = DeterministicRuntime::for_test(worker_count);
        let mut entities = source.to_vec();
        let entity_indices = state.factory_topology.ordinary_machine_indices.clone();
        let power_factors = matrix_power_factors(entities.len());
        let base = fixture_base();
        let base = base.as_object().unwrap();
        let outcomes = execute_local_machine_settlement_batch_with_runtime(
            &runtime,
            state,
            base,
            &mut entities,
            MachineLocalSettlementBatch { entity_indices },
            &[fixture_profile()],
            &power_factors,
            &crate::belts::OutputCredits::default(),
            DEFAULT_BUILDING_BUFFER_LIMIT,
            1.0,
        );
        let outcome_order = outcomes
            .iter()
            .map(|outcome| outcome.entity_index)
            .collect::<Vec<_>>();
        let mut produced = HashMap::new();
        for outcome in outcomes {
            merge_local_machine_production(state, outcome, &mut produced).unwrap();
        }
        (entities, produced, outcome_order)
    }

    fn planet_metric_fixture(count: usize) -> (CoreState, Vec<Value>) {
        let seed = local_machine_matrix(count);
        let mut state = fixture_state(&seed);
        let catalog = std::sync::Arc::make_mut(&mut state.catalog);
        let mut accumulator = fixture_building("accumulator");
        accumulator.kind = "power".to_owned();
        accumulator.energy_capacity_mj = 100.0;
        catalog
            .buildings
            .insert(accumulator.id.clone(), accumulator);
        let mut thermal = fixture_building("thermal_power_plant");
        thermal.kind = "power".to_owned();
        thermal.power_generation_kw = 12.0;
        thermal.fuel_item_ids = vec!["iron_ore".to_owned()];
        thermal.fuel_efficiency = 0.5;
        catalog.buildings.insert(thermal.id.clone(), thermal);

        let mut entities = seed;
        for (index, entity) in entities.iter_mut().enumerate() {
            entity["productionRate"] = Value::from(match index % 6 {
                0 => 10_000_000_000_000_000.0,
                1 | 2 => 1.0,
                3 => -10_000_000_000_000_000.0,
                4 => 0.25,
                _ => 0.5,
            });
            if index.is_multiple_of(17) {
                entity["buildingId"] = Value::from("accumulator");
                entity["machineCount"] = Value::from(2);
                entity["storedEnergyMj"] = Value::from(73.0);
            } else if index.is_multiple_of(23) {
                entity["buildingId"] = Value::from("thermal_power_plant");
                entity["machineCount"] = Value::from(3);
                entity["fuelItemId"] = Value::from("iron_ore");
                entity["fuelRemainingMj"] = Value::from(41.5);
            }
        }
        // Keep both legacy skip paths in the deterministic matrix.
        entities[5] = Value::Null;
        entities[11].as_object_mut().unwrap().remove("buildingId");
        (state, entities)
    }

    fn planet_metric_oactive_fixture(row_count: usize) -> CoreState {
        assert!(row_count >= 1);
        let mut entities = Vec::with_capacity(row_count);
        entities.push(json!({
            "id": "planet-metric-wind",
            "kind": "power",
            "planetId": "home",
            "powerGridId": "grid-a",
            "buildingId": "wind_turbine",
            "machineCount": 1,
            "minerCount": 0,
            "inputs": {},
            "outputs": {},
            "progress": 0,
            "utilization": 0,
            "productionRate": 0,
            "routingCursor": 0
        }));
        entities.extend((1..row_count).map(|index| {
            let production_rate = match index % 8 {
                0 => 10_000_000_000_000_000.0,
                1 => 1.0,
                2 => -10_000_000_000_000_000.0,
                3 => 0.25,
                4 => -0.0,
                5 => 0.5,
                6 => -0.125,
                _ => 0.0625,
            };
            json!({
                "id": format!("planet-metric-storage-{index:05}"),
                "kind": "storage",
                "planetId": "home",
                "powerGridId": "grid-a",
                "buildingId": "storage_mk1",
                "recipeId": null,
                "storedItemId": "iron_ingot",
                "machineCount": 1,
                "minerCount": 0,
                "inputs": {},
                "outputs": {},
                "progress": 0,
                "utilization": 0,
                "productionRate": production_rate,
                "routingCursor": 0
            })
        }));
        fixture_state_from_base_with_registry(
            construction_isolation_base(),
            &entities,
            crate::command::EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT,
        )
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    struct PlanetMetricOactiveRun {
        bytes: Vec<u8>,
        canonical: String,
        domain: String,
        conservation: String,
        scans: Vec<PlanetMetricScan>,
        selection_calls: (usize, usize),
    }

    fn run_planet_metric_oactive_advance(
        seconds: f64,
        worker_count: usize,
        mode: PlanetMetricProbeMode,
        step_size_override: Option<f64>,
    ) -> PlanetMetricOactiveRun {
        let mut state = planet_metric_oactive_fixture(1_024);
        let prepared = prepare_advance_with_planet_metric_test_options(
            &state,
            seconds,
            seconds,
            false,
            &DeterministicRuntime::for_test(worker_count),
            mode,
            step_size_override,
        )
        .unwrap();
        let scans = prepared
            .planet_metrics_runtime
            .scan_history_for_test()
            .to_vec();
        let selection_calls = prepared.planet_metrics_runtime.selection_calls_for_test();
        commit_and_install_factory_test_state(&mut state, prepared);
        PlanetMetricOactiveRun {
            bytes: serde_json::to_vec(&state.materialize().unwrap()).unwrap(),
            canonical: state.canonical_sha256().unwrap(),
            domain: state.domain_sha256().unwrap(),
            conservation: synthetic_conservation_sha256(&state),
            scans,
            selection_calls,
        }
    }

    fn advance_planet_metric_test_state(
        state: &mut CoreState,
        seconds: f64,
        step_size_override: f64,
    ) {
        let prepared = prepare_advance_with_planet_metric_test_options(
            state,
            seconds,
            seconds,
            false,
            &DeterministicRuntime::for_test(4),
            PlanetMetricProbeMode::Indexed,
            Some(step_size_override),
        )
        .unwrap();
        commit_and_install_exact_factory_test_state(state, prepared);
    }

    fn planet_metric_state_fingerprint(state: &CoreState) -> (Vec<u8>, String, String, String) {
        (
            serde_json::to_vec(&state.materialize().unwrap()).unwrap(),
            state.canonical_sha256().unwrap(),
            state.domain_sha256().unwrap(),
            synthetic_conservation_sha256(state),
        )
    }

    fn serial_planet_metrics_oracle(
        state: &CoreState,
        entities: &[Value],
        planet_count: usize,
    ) -> anyhow::Result<(Vec<f64>, Vec<PlanetPowerReserves>)> {
        let mut total_items_before_global = vec![0.0; planet_count];
        let mut power_reserves_by_planet = vec![(0.0, 0.0, 0.0, 0.0); planet_count];
        for (entity_index, entity) in entities.iter().enumerate() {
            let Some(entity) = entity.as_object() else {
                continue;
            };
            let planet = state.factory_topology.entity_planet_indices[entity_index];
            if planet == usize::MAX {
                continue;
            }
            total_items_before_global[planet] += finite_number(entity.get("productionRate"));
            let Some(building_id) = string_at(entity, "buildingId") else {
                continue;
            };
            let building = state
                .catalog
                .buildings
                .get(building_id)
                .ok_or_else(|| anyhow!("native power reserve building is missing"))?;
            let reserves = &mut power_reserves_by_planet[planet];
            if matches!(building_id, "accumulator" | "energy_exchanger") {
                reserves.0 += stored_energy(entity, building);
                reserves.1 += energy_capacity(entity, building);
            } else if is_fuel_generator(building_id) {
                reserves.2 +=
                    fuel_energy_available(state, entity, building) * building.fuel_efficiency;
                reserves.3 +=
                    building.power_generation_kw * finite_number(entity.get("machineCount"));
            }
        }
        Ok((total_items_before_global, power_reserves_by_planet))
    }

    #[test]
    fn machine_item_number_overwrites_existing_keys_and_preserves_number_fallbacks() {
        let mut values = json!({
            "alpha": 1,
            "mod:插件物料": 2,
            "omega": 3
        })
        .as_object()
        .unwrap()
        .clone();
        let existing_key_ptr = values
            .iter()
            .find(|(key, _)| key.as_str() == "mod:插件物料")
            .unwrap()
            .0
            .as_ptr();
        let original_keys = values.keys().cloned().collect::<Vec<_>>();

        set_machine_item_number(&mut values, "mod:插件物料", 9.5);

        let updated_key_ptr = values
            .iter()
            .find(|(key, _)| key.as_str() == "mod:插件物料")
            .unwrap()
            .0
            .as_ptr();
        assert_eq!(updated_key_ptr, existing_key_ptr);
        assert_eq!(values.keys().cloned().collect::<Vec<_>>(), original_keys);
        assert_eq!(values.get("mod:插件物料"), Some(&Value::from(9.5)));

        set_machine_item_number(&mut values, "beta", 4.0);
        assert_eq!(
            values.keys().map(String::as_str).collect::<Vec<_>>(),
            vec!["alpha", "beta", "mod:插件物料", "omega"]
        );

        set_machine_item_number(&mut values, "negative-zero", -0.0);
        assert_eq!(
            serde_json::to_string(values.get("negative-zero").unwrap()).unwrap(),
            "-0.0"
        );
        for (key, value) in [
            ("not-a-number", f64::NAN),
            ("positive-infinity", f64::INFINITY),
            ("negative-infinity", f64::NEG_INFINITY),
        ] {
            set_machine_item_number(&mut values, key, value);
            assert_eq!(values.get(key), Some(&Value::from(0)));
        }
    }

    #[test]
    fn machine_item_number_updates_multiple_input_output_and_bonus_records() {
        let recipe = fixture_recipe(
            "mod:multi-io",
            "arc_smelter",
            None,
            vec![
                ItemAmount {
                    item_id: "iron_ore".to_owned(),
                    amount: 2.0,
                },
                ItemAmount {
                    item_id: "mod:稀有矿".to_owned(),
                    amount: 1.5,
                },
            ],
            vec![
                ItemAmount {
                    item_id: "iron_ingot".to_owned(),
                    amount: 1.0,
                },
                ItemAmount {
                    item_id: "mod:合金".to_owned(),
                    amount: 0.5,
                },
            ],
        );
        let mut inputs = json!({ "iron_ore": 9, "mod:稀有矿": 7 })
            .as_object()
            .unwrap()
            .clone();
        let mut outputs = json!({ "iron_ingot": 3 }).as_object().unwrap().clone();
        let mut bonus_progress = json!({ "iron_ingot": 0.75 }).as_object().unwrap().clone();

        for input in &recipe.inputs {
            let current = finite_number(inputs.get(&input.item_id));
            set_machine_item_number(
                &mut inputs,
                &input.item_id,
                (current - input.amount * 2.0).max(0.0).floor(),
            );
        }
        for output in &recipe.outputs {
            let current = finite_number(outputs.get(&output.item_id));
            set_machine_item_number(
                &mut outputs,
                &output.item_id,
                (current + output.amount * 2.0).floor(),
            );
            let current_bonus = finite_number(bonus_progress.get(&output.item_id));
            set_machine_item_number(
                &mut bonus_progress,
                &output.item_id,
                (current_bonus + output.amount * 0.25).max(0.0),
            );
        }

        assert_eq!(
            &inputs,
            json!({ "iron_ore": 5.0, "mod:稀有矿": 4.0 })
                .as_object()
                .unwrap()
        );
        assert_eq!(
            &outputs,
            json!({ "iron_ingot": 5.0, "mod:合金": 1.0 })
                .as_object()
                .unwrap()
        );
        assert_eq!(
            &bonus_progress,
            json!({ "iron_ingot": 1.0, "mod:合金": 0.125 })
                .as_object()
                .unwrap()
        );
        assert_eq!(
            outputs.keys().map(String::as_str).collect::<Vec<_>>(),
            vec!["iron_ingot", "mod:合金"]
        );
    }

    #[test]
    fn indexed_power_probe_uses_injected_pool_and_preserves_order() {
        let runtime = DeterministicRuntime::for_test(4);
        let values = (0..PARALLEL_MIN_ITEMS + 257).collect::<Vec<_>>();
        let observed = collect_indexed_power_probes_with_runtime(&runtime, &values, |&value| {
            if value % 127 == 0 {
                std::thread::yield_now();
            }
            (value, rayon::current_num_threads())
        });

        assert_eq!(
            observed.iter().map(|(value, _)| *value).collect::<Vec<_>>(),
            values
        );
        assert!(observed.iter().all(|(_, worker_count)| *worker_count == 4));
    }

    #[test]
    fn indexed_power_probe_keeps_small_inputs_serial() {
        let runtime = DeterministicRuntime::for_test(4);
        let values = [7_usize, 3, 11, 5];
        let observed = collect_indexed_power_probes_with_runtime(&runtime, &values, |&value| {
            (value, rayon::current_thread_index())
        });

        assert_eq!(observed, vec![(7, None), (3, None), (11, None), (5, None)]);
    }

    #[test]
    fn power_probe_runtime_skips_static_json_probes_but_replays_persisted_order() {
        let state = power_probe_oactive_fixture(1_024, 1);
        let entities = state.parse_entities_parallel().unwrap();
        let mut power_runtime = std::sync::Arc::new(PowerProbeRuntime::build(&state, &entities));
        let profiles = [fixture_profile()];
        let reception = crate::dyson::Reception::default();
        let mut first_grids = vec![GridRuntime::default(); GRID_IDS.len()];
        let first = collect_power_sources_with_runtime(
            &DeterministicRuntime::for_test(4),
            &state,
            &entities,
            &reception,
            &profiles,
            DEFAULT_BUILDING_BUFFER_LIMIT,
            1.0,
            &mut power_runtime,
            PowerProbeMode::Indexed,
            &mut first_grids,
        )
        .unwrap()
        .scan;
        let mut second_grids = vec![GridRuntime::default(); GRID_IDS.len()];
        let second = collect_power_sources_with_runtime(
            &DeterministicRuntime::for_test(4),
            &state,
            &entities,
            &reception,
            &profiles,
            DEFAULT_BUILDING_BUFFER_LIMIT,
            1.0,
            &mut power_runtime,
            PowerProbeMode::Indexed,
            &mut second_grids,
        )
        .unwrap()
        .scan;

        assert_eq!(first.selected_rows, 1_025);
        assert!(first.full_scan);
        assert_eq!(second.selected_rows, 1);
        assert_eq!(second.stable_rows_skipped, 1_024);
        assert_eq!(second.compact_replay_rows, 1_025);
        assert!(!second.full_scan);
        assert_eq!(
            power_generation_capacity_in_js_order(&first_grids[0]),
            power_generation_capacity_in_js_order(&second_grids[0])
        );
        assert_eq!(
            first_grids[0].generator_count.to_bits(),
            second_grids[0].generator_count.to_bits()
        );
        assert_eq!(
            first_grids[0].power_output_by_entity,
            second_grids[0].power_output_by_entity
        );
        assert_eq!(power_runtime.selection_calls_for_test(), (2, 0));
    }

    #[test]
    fn renewable_display_fields_are_stable_across_low_high_low_grid_demand() {
        const RENEWABLES: usize = 32;
        let state = power_probe_oactive_fixture(RENEWABLES, 1);
        let mut entities = state.parse_entities_parallel().unwrap();
        let mut power_runtime = std::sync::Arc::new(PowerProbeRuntime::build(&state, &entities));
        let profiles = [fixture_profile()];
        let reception = crate::dyson::Reception::default();
        let mut stable_bytes = None;
        for (step, demand_kw) in [1.0, 1_000_000_000.0, 1.0].into_iter().enumerate() {
            let mut grids = vec![GridRuntime::default(); GRID_IDS.len()];
            let prepared = collect_power_sources_with_runtime(
                &DeterministicRuntime::for_test(4),
                &state,
                &entities,
                &reception,
                &profiles,
                DEFAULT_BUILDING_BUFFER_LIMIT,
                1.0,
                &mut power_runtime,
                PowerProbeMode::Indexed,
                &mut grids,
            )
            .unwrap();
            let grid = &mut grids[0];
            (grid.base_generation_kw, grid.generation_kw) =
                power_generation_capacity_in_js_order(grid);
            grid.demand_kw = demand_kw;
            grid.regular_supplied_kw = demand_kw.min(grid.generation_kw);
            grid.supplied_kw = grid.regular_supplied_kw;
            let missing_kw = (grid.supplied_kw - grid.base_generation_kw).max(0.0);
            let candidates = grid.dispatch_candidates.clone();
            allocate_power_by_priority(&candidates, missing_kw, &mut grid.power_output_by_entity);
            grid.factor = if demand_kw <= EPSILON {
                1.0
            } else {
                (grid.supplied_kw / demand_kw).min(1.0)
            };
            let patches = collect_renewable_power_facility_patches_with_runtime(
                &DeterministicRuntime::for_test(4),
                &state,
                &entities,
                &prepared.settlement_entity_indices,
                &grids,
            )
            .unwrap();
            if step == 0 {
                assert_eq!(patches.len(), RENEWABLES, "cold pass must patch all");
            } else {
                assert!(patches.is_empty(), "warm static renewables must sleep");
            }
            for patch in patches {
                let entity_index = patch.entity_index;
                apply_renewable_power_facility_patch(&mut entities[entity_index], patch).unwrap();
            }
            let bytes = serde_json::to_vec(&entities[..RENEWABLES]).unwrap();
            if let Some(expected) = &stable_bytes {
                assert_eq!(
                    &bytes, expected,
                    "renewable display bytes changed at demand step {step}"
                );
            } else {
                stable_bytes = Some(bytes);
            }
        }
    }

    #[test]
    fn power_probe_indexed_and_flat_oracle_match_full_state_at_1_5_60_seconds() {
        for seconds in [1.0, 5.0, 60.0] {
            let indexed = run_power_probe_advance(
                power_probe_oactive_fixture(257, 1),
                seconds,
                4,
                PowerProbeMode::Indexed,
            );
            let oracle = run_power_probe_advance(
                power_probe_oactive_fixture(257, 1),
                seconds,
                4,
                PowerProbeMode::FlatFull,
            );
            assert_eq!(indexed.bytes, oracle.bytes, "bytes at {seconds}s");
            assert_eq!(
                indexed.canonical, oracle.canonical,
                "canonical at {seconds}s"
            );
            assert_eq!(indexed.domain, oracle.domain, "domain at {seconds}s");
            assert_eq!(indexed.scans.len(), seconds as usize);
            assert_eq!(oracle.scans.len(), seconds as usize);
            assert!(oracle.scans.iter().all(|scan| {
                scan.full_scan && scan.selected_rows == 258 && scan.compact_replay_rows == 258
            }));
            if seconds > 1.0 {
                assert!(indexed.scans[0].full_scan);
                assert!(indexed.scans[1..].iter().all(|scan| {
                    !scan.full_scan
                        && scan.selected_rows == 1
                        && scan.stable_rows_skipped == 257
                        && scan.compact_replay_rows == 258
                }));
            }
        }
    }

    #[test]
    fn power_probe_full_state_is_deterministic_at_1_2_4_8_workers() {
        let baseline = run_power_probe_advance(
            power_probe_oactive_fixture(1_029, 3),
            5.0,
            1,
            PowerProbeMode::Indexed,
        );
        for workers in [2, 4, 8] {
            let observed = run_power_probe_advance(
                power_probe_oactive_fixture(1_029, 3),
                5.0,
                workers,
                PowerProbeMode::Indexed,
            );
            assert_eq!(observed.bytes, baseline.bytes, "bytes at {workers} workers");
            assert_eq!(
                observed.canonical, baseline.canonical,
                "canonical at {workers} workers"
            );
            assert_eq!(
                observed.domain, baseline.domain,
                "domain at {workers} workers"
            );
            assert_eq!(observed.scans, baseline.scans);
        }
    }

    #[test]
    fn power_probe_research_completion_boundary_matches_flat_oracle() {
        let indexed = run_power_probe_advance(
            research_boundary_fixture(257, 1.0, 99_999.0),
            5.0,
            4,
            PowerProbeMode::Indexed,
        );
        let oracle = run_power_probe_advance(
            research_boundary_fixture(257, 1.0, 99_999.0),
            5.0,
            4,
            PowerProbeMode::FlatFull,
        );
        assert_eq!(indexed.bytes, oracle.bytes);
        assert_eq!(indexed.canonical, oracle.canonical);
        assert_eq!(indexed.domain, oracle.domain);
        assert_eq!(indexed.scans.len(), 5);
        assert_eq!(indexed.scans[0].selected_rows, 1);
        assert!(
            indexed.scans[1..]
                .iter()
                .all(|scan| scan.selected_rows == 0 && scan.compact_replay_rows == 1)
        );
        assert!(oracle.scans.iter().all(|scan| scan.selected_rows == 1));
    }

    #[test]
    fn power_probe_global_profile_change_and_dense_dynamic_set_fail_closed() {
        let state = power_probe_oactive_fixture(32, 1);
        let entities = state.parse_entities_parallel().unwrap();
        let mut power_runtime = std::sync::Arc::new(PowerProbeRuntime::build(&state, &entities));
        let reception = crate::dyson::Reception::default();
        for (profiles, expected_full) in [
            ([fixture_profile()], true),
            ([fixture_profile()], false),
            (
                [PlanetProfile {
                    solar_power_multiplier: 1.25,
                    ..fixture_profile()
                }],
                true,
            ),
        ] {
            let mut grids = vec![GridRuntime::default(); GRID_IDS.len()];
            let scan = collect_power_sources_with_runtime(
                &DeterministicRuntime::for_test(4),
                &state,
                &entities,
                &reception,
                &profiles,
                DEFAULT_BUILDING_BUFFER_LIMIT,
                1.0,
                &mut power_runtime,
                PowerProbeMode::Indexed,
                &mut grids,
            )
            .unwrap()
            .scan;
            assert_eq!(scan.full_scan, expected_full);
        }

        let dense_state = power_probe_oactive_fixture(1, 3);
        let dense_entities = dense_state.parse_entities_parallel().unwrap();
        let mut dense_runtime =
            std::sync::Arc::new(PowerProbeRuntime::build(&dense_state, &dense_entities));
        for _ in 0..2 {
            let mut grids = vec![GridRuntime::default(); GRID_IDS.len()];
            let scan = collect_power_sources_with_runtime(
                &DeterministicRuntime::for_test(4),
                &dense_state,
                &dense_entities,
                &reception,
                &[fixture_profile()],
                DEFAULT_BUILDING_BUFFER_LIMIT,
                1.0,
                &mut dense_runtime,
                PowerProbeMode::Indexed,
                &mut grids,
            )
            .unwrap()
            .scan;
            assert!(scan.full_scan && scan.dense_fallback);
            assert_eq!(scan.selected_rows, 4);
        }
    }

    #[test]
    fn power_probe_ray_receiver_stays_dynamic_when_dyson_reception_changes() {
        let mut state = power_probe_oactive_fixture(32, 0);
        let catalog = std::sync::Arc::make_mut(&mut state.catalog);
        catalog
            .buildings
            .insert("ray_receiver".to_owned(), fixture_building("ray_receiver"));
        catalog.recipes.insert(
            "ray_power".to_owned(),
            fixture_recipe("ray_power", "ray_receiver", None, vec![], vec![]),
        );
        let receiver_index = 31;
        state.replace_entity_raw(
            receiver_index,
            serde_json::to_string(&json!({
                "id": "power-probe-ray-receiver",
                "kind": "machine",
                "planetId": "home",
                "powerGridId": "grid-a",
                "buildingId": "ray_receiver",
                "recipeId": "ray_power",
                "machineCount": 1,
                "minerCount": 0,
                "inputs": {},
                "outputs": {},
                "progress": 0,
                "utilization": 0,
                "productionRate": 0,
                "powerOutputKw": 0,
                "powerInputKw": 0,
                "routingCursor": 0
            }))
            .unwrap()
            .into(),
        );
        state.rebuild_indexes().unwrap();
        state.refresh_factory_static_admission().unwrap();
        assert_eq!(state.factory_topology.power_source_indices.len(), 32);
        let entities = state.parse_entities_parallel().unwrap();
        let mut runtime = std::sync::Arc::new(PowerProbeRuntime::build(&state, &entities));
        let profiles = [fixture_profile()];
        let mut cold_grids = vec![GridRuntime::default(); GRID_IDS.len()];
        collect_power_sources_with_runtime(
            &DeterministicRuntime::for_test(4),
            &state,
            &entities,
            &crate::dyson::Reception::default(),
            &profiles,
            DEFAULT_BUILDING_BUFFER_LIMIT,
            1.0,
            &mut runtime,
            PowerProbeMode::Indexed,
            &mut cold_grids,
        )
        .unwrap();
        let mut changed_reception = crate::dyson::Reception::default();
        changed_reception
            .ray_power_by_entity
            .insert("power-probe-ray-receiver".to_owned(), 12_345.25);
        let mut indexed_grids = vec![GridRuntime::default(); GRID_IDS.len()];
        let indexed_scan = collect_power_sources_with_runtime(
            &DeterministicRuntime::for_test(4),
            &state,
            &entities,
            &changed_reception,
            &profiles,
            DEFAULT_BUILDING_BUFFER_LIMIT,
            1.0,
            &mut runtime,
            PowerProbeMode::Indexed,
            &mut indexed_grids,
        )
        .unwrap()
        .scan;
        assert_eq!(indexed_scan.selected_rows, 1);
        assert_eq!(indexed_grids[0].ray_generation_kw, 12_345.25);

        let mut flat_runtime = std::sync::Arc::new(PowerProbeRuntime::build(&state, &entities));
        let mut flat_grids = vec![GridRuntime::default(); GRID_IDS.len()];
        let flat_scan = collect_power_sources_with_runtime(
            &DeterministicRuntime::for_test(4),
            &state,
            &entities,
            &changed_reception,
            &profiles,
            DEFAULT_BUILDING_BUFFER_LIMIT,
            1.0,
            &mut flat_runtime,
            PowerProbeMode::FlatFull,
            &mut flat_grids,
        )
        .unwrap()
        .scan;
        assert_eq!(flat_scan.selected_rows, 32);
        assert_eq!(
            power_generation_capacity_in_js_order(&indexed_grids[0]),
            power_generation_capacity_in_js_order(&flat_grids[0])
        );
        assert_eq!(
            indexed_grids[0].power_output_by_entity,
            flat_grids[0].power_output_by_entity
        );
    }

    #[test]
    fn power_probe_mixed_fuel_ray_outage_restore_keeps_static_renewables_asleep() {
        const STATIC_RENEWABLES: usize = 32;
        let mut state = power_probe_oactive_fixture(STATIC_RENEWABLES + 1, 1);
        let catalog = std::sync::Arc::make_mut(&mut state.catalog);
        catalog
            .buildings
            .insert("ray_receiver".to_owned(), fixture_building("ray_receiver"));
        catalog.recipes.insert(
            "ray_power".to_owned(),
            fixture_recipe("ray_power", "ray_receiver", None, vec![], vec![]),
        );
        let receiver_index = STATIC_RENEWABLES;
        let thermal_index = STATIC_RENEWABLES + 1;
        state.replace_entity_raw(
            receiver_index,
            serde_json::to_string(&json!({
                "id": "power-probe-mixed-ray",
                "kind": "machine",
                "planetId": "home",
                "powerGridId": "grid-a",
                "buildingId": "ray_receiver",
                "recipeId": "ray_power",
                "machineCount": 1,
                "minerCount": 0,
                "inputs": {},
                "outputs": {},
                "progress": 0,
                "utilization": 0,
                "productionRate": 0,
                "powerOutputKw": 0,
                "powerInputKw": 0,
                "routingCursor": 0
            }))
            .unwrap()
            .into(),
        );
        state.rebuild_indexes().unwrap();
        state.refresh_factory_static_admission().unwrap();

        let mut entities = state.parse_entities_parallel().unwrap();
        // Keep the static sources present in the topology while making the
        // synthetic outage observable without a residual renewable supply.
        for entity in &mut entities[..STATIC_RENEWABLES] {
            entity["machineCount"] = Value::from(0);
        }
        entities[thermal_index]["fuelRemainingMj"] = Value::from(0.0);
        entities[thermal_index]["inputs"]["coal"] = Value::from(0.0);

        let profiles = [fixture_profile()];
        let mut runtime = std::sync::Arc::new(PowerProbeRuntime::build(&state, &entities));
        let mut stable_renewable_bytes = None;
        for (phase, (coal, ray_power, expect_generation)) in [
            (0.0, 0.0, false),
            (10.0, 12_345.25, true),
            (0.0, 0.0, false),
        ]
        .into_iter()
        .enumerate()
        {
            entities[thermal_index]["inputs"]["coal"] = Value::from(coal);
            let mut reception = crate::dyson::Reception::default();
            if ray_power > 0.0 {
                reception
                    .ray_power_by_entity
                    .insert("power-probe-mixed-ray".to_owned(), ray_power);
            }
            let mut indexed_grids = vec![GridRuntime::default(); GRID_IDS.len()];
            let prepared = collect_power_sources_with_runtime(
                &DeterministicRuntime::for_test(4),
                &state,
                &entities,
                &reception,
                &profiles,
                DEFAULT_BUILDING_BUFFER_LIMIT,
                1.0,
                &mut runtime,
                PowerProbeMode::Indexed,
                &mut indexed_grids,
            )
            .unwrap();
            if phase == 0 {
                assert!(prepared.scan.full_scan);
                assert_eq!(prepared.scan.selected_rows, STATIC_RENEWABLES + 2);
            } else {
                assert!(!prepared.scan.full_scan);
                assert_eq!(prepared.scan.selected_rows, 2);
                assert_eq!(prepared.scan.stable_rows_skipped, STATIC_RENEWABLES);
            }

            let (_, indexed_generation) = power_generation_capacity_in_js_order(&indexed_grids[0]);
            assert_eq!(indexed_generation > EPSILON, expect_generation);

            let mut flat_runtime = std::sync::Arc::new(PowerProbeRuntime::build(&state, &entities));
            let mut flat_grids = vec![GridRuntime::default(); GRID_IDS.len()];
            let flat = collect_power_sources_with_runtime(
                &DeterministicRuntime::for_test(4),
                &state,
                &entities,
                &reception,
                &profiles,
                DEFAULT_BUILDING_BUFFER_LIMIT,
                1.0,
                &mut flat_runtime,
                PowerProbeMode::FlatFull,
                &mut flat_grids,
            )
            .unwrap();
            assert!(flat.scan.full_scan);
            assert_eq!(flat.scan.selected_rows, STATIC_RENEWABLES + 2);
            assert_eq!(
                power_generation_capacity_in_js_order(&indexed_grids[0]),
                power_generation_capacity_in_js_order(&flat_grids[0])
            );
            assert_eq!(
                indexed_grids[0].power_output_by_entity,
                flat_grids[0].power_output_by_entity
            );

            let patches = collect_renewable_power_facility_patches_with_runtime(
                &DeterministicRuntime::for_test(4),
                &state,
                &entities,
                &prepared.settlement_entity_indices,
                &indexed_grids,
            )
            .unwrap();
            if phase == 0 {
                assert_eq!(patches.len(), STATIC_RENEWABLES);
            } else {
                assert!(patches.is_empty());
            }
            for patch in patches {
                let entity_index = patch.entity_index;
                apply_renewable_power_facility_patch(&mut entities[entity_index], patch).unwrap();
            }
            let bytes = serde_json::to_vec(&entities[..STATIC_RENEWABLES]).unwrap();
            if let Some(expected) = &stable_renewable_bytes {
                assert_eq!(
                    &bytes, expected,
                    "static renewable bytes changed in phase {phase}"
                );
            } else {
                stable_renewable_bytes = Some(bytes);
            }
        }
    }

    #[test]
    fn power_probe_mod_malformed_and_topology_drift_stay_on_full_oracle() {
        for malformed in [false, true] {
            let state = power_probe_oactive_fixture(32, 0);
            let mut entities = state.parse_entities_parallel().unwrap();
            if malformed {
                entities[7]["machineCount"] = Value::from("opaque-number");
            } else {
                entities[7]["mod:power-writer"] = json!({ "enabled": true });
            }
            let mut power_runtime =
                std::sync::Arc::new(PowerProbeRuntime::build(&state, &entities));
            for _ in 0..2 {
                let mut grids = vec![GridRuntime::default(); GRID_IDS.len()];
                let scan = collect_power_sources_with_runtime(
                    &DeterministicRuntime::for_test(4),
                    &state,
                    &entities,
                    &crate::dyson::Reception::default(),
                    &[fixture_profile()],
                    DEFAULT_BUILDING_BUFFER_LIMIT,
                    1.0,
                    &mut power_runtime,
                    PowerProbeMode::Indexed,
                    &mut grids,
                )
                .unwrap()
                .scan;
                assert!(scan.full_scan && scan.directory_fallback);
                assert_eq!(scan.selected_rows, 32);
            }
        }

        let mut drifted = power_probe_oactive_fixture(32, 0);
        let entities = drifted.parse_entities_parallel().unwrap();
        let mut power_runtime = std::sync::Arc::new(PowerProbeRuntime::build(&drifted, &entities));
        let mut grids = vec![GridRuntime::default(); GRID_IDS.len()];
        collect_power_sources_with_runtime(
            &DeterministicRuntime::for_test(4),
            &drifted,
            &entities,
            &crate::dyson::Reception::default(),
            &[fixture_profile()],
            DEFAULT_BUILDING_BUFFER_LIMIT,
            1.0,
            &mut power_runtime,
            PowerProbeMode::Indexed,
            &mut grids,
        )
        .unwrap();
        drifted.factory_topology = std::sync::Arc::new((*drifted.factory_topology).clone());
        let mut drift_grids = vec![GridRuntime::default(); GRID_IDS.len()];
        let scan = collect_power_sources_with_runtime(
            &DeterministicRuntime::for_test(4),
            &drifted,
            &entities,
            &crate::dyson::Reception::default(),
            &[fixture_profile()],
            DEFAULT_BUILDING_BUFFER_LIMIT,
            1.0,
            &mut power_runtime,
            PowerProbeMode::Indexed,
            &mut drift_grids,
        )
        .unwrap()
        .scan;
        assert!(scan.full_scan && scan.directory_fallback);
    }

    #[test]
    fn failed_power_probe_candidate_keeps_source_bytes_hash_and_runtime() {
        let mut state = power_probe_oactive_fixture(257, 1);
        let prepared = prepare_advance_with_power_probe_test_options(
            &state,
            1.0,
            1.0,
            false,
            &DeterministicRuntime::for_test(4),
            PowerProbeMode::Indexed,
            Some(1.0),
        )
        .unwrap();
        commit_and_install_factory_test_state(&mut state, prepared);
        let source_runtime = state.prepared_power_probe_runtime().unwrap();
        let source_history = source_runtime.scan_history_for_test().to_vec();
        let source_bytes = serde_json::to_vec(&state.materialize().unwrap()).unwrap();
        let source_hash = state.canonical_sha256().unwrap();
        let source_revision = state.revision;

        for (mode, expected_error) in [
            (
                PowerProbeMode::IndexedFailAfterCollect,
                "injected failure after power probe candidate collection",
            ),
            (
                PowerProbeMode::IndexedFailAfterRuntimeMutation,
                "injected failure after power probe runtime mutation",
            ),
        ] {
            let error = match prepare_advance_with_power_probe_test_options(
                &state,
                1.0,
                1.0,
                false,
                &DeterministicRuntime::for_test(4),
                mode,
                Some(1.0),
            ) {
                Ok(_) => panic!("injected power probe failure unexpectedly committed"),
                Err(error) => error,
            };
            assert!(format!("{error:#}").contains(expected_error));
            assert_eq!(state.revision, source_revision);
            assert_eq!(state.canonical_sha256().unwrap(), source_hash);
            assert_eq!(
                serde_json::to_vec(&state.materialize().unwrap()).unwrap(),
                source_bytes
            );
            let retained = state.prepared_power_probe_runtime().unwrap();
            assert!(std::sync::Arc::ptr_eq(&source_runtime, &retained));
            assert_eq!(retained.scan_history_for_test(), source_history);
        }
    }

    #[test]
    fn power_probe_memory_estimate_includes_candidate_peak_buffers() {
        let state = power_probe_oactive_fixture(1_024, 3);
        let prepared = prepare_advance_with_power_probe_test_options(
            &state,
            1.0,
            1.0,
            false,
            &DeterministicRuntime::for_test(4),
            PowerProbeMode::Indexed,
            Some(1.0),
        )
        .unwrap();
        let runtime = prepared.power_probe_runtime;
        let sources = runtime.source_count as u64;
        let dynamic = runtime.dynamic_source_slots.capacity() as u64;
        let profile_rows = runtime
            .profile_signature
            .as_ref()
            .map(Vec::capacity)
            .unwrap_or(0) as u64;
        let conservative_candidate_lower_bound = (std::mem::size_of::<PowerProbeRuntime>() as u64)
            .saturating_mul(2)
            .saturating_add(
                sources
                    .saturating_mul(std::mem::size_of::<Option<StaticRenewablePowerProbe>>() as u64)
                    .saturating_mul(2),
            )
            .saturating_add(
                sources.saturating_mul(std::mem::size_of::<Option<PowerSourceProbe>>() as u64),
            )
            .saturating_add(
                sources
                    .saturating_mul(std::mem::size_of::<usize>() as u64)
                    .saturating_mul(2),
            )
            .saturating_add(dynamic.saturating_mul(std::mem::size_of::<usize>() as u64))
            .saturating_add(
                profile_rows
                    .saturating_mul(std::mem::size_of::<[u64; 3]>() as u64)
                    .saturating_mul(2),
            );
        assert!(runtime.estimated_bytes() >= conservative_candidate_lower_bound);
    }

    #[test]
    #[ignore = "synthetic wall-clock evidence; run explicitly outside correctness gates"]
    fn power_probe_synthetic_wall_clock_ab_evidence() {
        const SOURCES: usize = 16_384;
        const ROUNDS: usize = 9;
        let indexed_state = power_probe_oactive_fixture(SOURCES, 1);
        let flat_state = power_probe_oactive_fixture(SOURCES, 1);
        let indexed_start = std::time::Instant::now();
        let indexed =
            run_power_probe_advance(indexed_state, ROUNDS as f64, 4, PowerProbeMode::Indexed);
        let indexed_elapsed = indexed_start.elapsed();
        let flat_start = std::time::Instant::now();
        let flat = run_power_probe_advance(flat_state, ROUNDS as f64, 4, PowerProbeMode::FlatFull);
        let flat_elapsed = flat_start.elapsed();
        assert_eq!(indexed.bytes, flat.bytes);
        assert_eq!(indexed.canonical, flat.canonical);
        assert_eq!(indexed.domain, flat.domain);
        let indexed_probes = indexed
            .scans
            .iter()
            .map(|scan| scan.selected_rows)
            .sum::<usize>();
        let flat_probes = flat
            .scans
            .iter()
            .map(|scan| scan.selected_rows)
            .sum::<usize>();
        eprintln!(
            "power-probe-ab\tsources={}\trounds={}\tindexed-probes={}\tflat-probes={}\tcompact-replay={}\tindexed-us={}\tflat-us={}",
            SOURCES + 1,
            ROUNDS,
            indexed_probes,
            flat_probes,
            indexed
                .scans
                .iter()
                .map(|scan| scan.compact_replay_rows)
                .sum::<usize>(),
            indexed_elapsed.as_micros(),
            flat_elapsed.as_micros(),
        );
    }

    #[test]
    fn power_generation_groups_base_sources_in_javascript_order() {
        let mut runtime = GridRuntime {
            wind_generation_kw: 5_571_240.0,
            solar_generation_kw: f64::from_bits(0x4185_4d74_0ccc_cccd),
            geothermal_generation_kw: 1_883_520.0,
            ..GridRuntime::default()
        };
        let ray_term = f64::from_bits(0x42b4_92a1_1098_0001);

        // Minimal real-shape differential: the old Rust path encountered the
        // three renewable classes and then three huge ray rows in entity
        // order. JavaScript accumulates the ray rows separately first.
        let mut mixed_entity_order = 0.0;
        mixed_entity_order += runtime.geothermal_generation_kw;
        mixed_entity_order += runtime.wind_generation_kw;
        mixed_entity_order += runtime.solar_generation_kw;
        for _ in 0..3 {
            mixed_entity_order += ray_term;
            runtime.ray_generation_kw += ray_term;
        }

        let (base_generation_kw, generation_kw) = power_generation_capacity_in_js_order(&runtime);
        assert_eq!(mixed_entity_order.to_bits(), 0x42ce_dbf3_269b_54ce);
        assert_eq!(base_generation_kw.to_bits(), 0x42ce_dbf3_269b_54cf);
        assert_eq!(generation_kw.to_bits(), base_generation_kw.to_bits());
    }

    #[test]
    fn power_generation_adds_dispatch_classes_in_javascript_order() {
        let mut runtime = GridRuntime {
            wind_generation_kw: 18_014_398_509_481_984.0,
            ..GridRuntime::default()
        };
        runtime.dispatch_candidates = vec![
            PowerCandidate {
                entity_index: 0,
                capacity: 1.0,
                priority: 1,
                kind: DispatchKind::Accumulator,
            },
            PowerCandidate {
                entity_index: 1,
                capacity: 1.0,
                priority: 1,
                kind: DispatchKind::Thermal,
            },
            PowerCandidate {
                entity_index: 2,
                capacity: 1.0,
                priority: 1,
                kind: DispatchKind::Exchanger,
            },
        ];

        let mixed_dispatch_capacity = runtime
            .dispatch_candidates
            .iter()
            .map(|candidate| candidate.capacity)
            .sum::<f64>();
        let legacy_generation_kw = runtime.wind_generation_kw + mixed_dispatch_capacity;
        let (base_generation_kw, generation_kw) = power_generation_capacity_in_js_order(&runtime);

        assert_eq!(base_generation_kw.to_bits(), 0x4350_0000_0000_0000);
        assert_eq!(legacy_generation_kw.to_bits(), 0x4350_0000_0000_0001);
        assert_eq!(generation_kw.to_bits(), 0x4350_0000_0000_0000);
    }

    #[test]
    fn indexed_factory_probe_updates_private_slots_in_injected_pool() {
        let runtime = DeterministicRuntime::for_test(4);
        let mut values = (0..PARALLEL_MIN_ITEMS + 257)
            .map(|value| (value, 0))
            .collect::<Vec<_>>();
        update_indexed_factory_probes_with_runtime(&runtime, &mut values, |slot| {
            if slot.0 % 127 == 0 {
                std::thread::yield_now();
            }
            slot.1 = rayon::current_num_threads();
        });

        assert!(
            values
                .iter()
                .enumerate()
                .all(|(index, &(value, workers))| value == index && workers == 4)
        );
    }

    #[test]
    fn renewable_power_patches_match_the_serial_oracle_and_canonical_bytes_at_all_workers() {
        let source = renewable_power_matrix(PARALLEL_MIN_ITEMS + 137);
        let state = fixture_state(&source);
        let grids = renewable_power_grids(source.len());
        let oracle = serial_renewable_power_oracle(&state, &source, &grids);
        let oracle_bytes = serde_json::to_vec(&oracle).unwrap();
        let oracle_hash = fixture_state(&oracle).canonical_sha256().unwrap();

        for worker_count in [1, 2, 4, 8] {
            let (observed, workers) =
                run_renewable_power_patches(&state, &source, &grids, worker_count);
            assert_eq!(
                serde_json::to_vec(&observed).unwrap(),
                oracle_bytes,
                "renewable entity bytes diverged for {worker_count} workers",
            );
            assert_eq!(
                fixture_state(&observed).canonical_sha256().unwrap(),
                oracle_hash,
                "renewable canonical hash diverged for {worker_count} workers",
            );
            if worker_count == 1 {
                assert!(workers.iter().all(Option::is_none));
            } else {
                assert!(workers.iter().any(Option::is_some));
            }
        }
    }

    #[test]
    fn renewable_power_patches_are_segment_invariant_for_one_five_and_sixty_seconds() {
        let source = renewable_power_matrix(PARALLEL_MIN_ITEMS + 19);
        let state = fixture_state(&source);
        let grids = renewable_power_grids(source.len());
        let run = |segments: &[usize]| {
            let mut entities = source.clone();
            for &segment_seconds in segments {
                assert!(matches!(segment_seconds, 1 | 5 | 60));
                entities = run_renewable_power_patches(&state, &entities, &grids, 8).0;
            }
            let bytes = serde_json::to_vec(&entities).unwrap();
            (fixture_checksum(&bytes), bytes)
        };

        let one_sixty_second_step = run(&[60]);
        let twelve_five_second_steps = run(&[5; 12]);
        let sixty_one_second_steps = run(&[1; 60]);
        assert_eq!(twelve_five_second_steps, one_sixty_second_step);
        assert_eq!(sixty_one_second_steps, one_sixty_second_step);
    }

    #[test]
    fn renewable_power_patch_selection_leaves_fuel_storage_and_machine_rows_serial() {
        let mut source = renewable_power_matrix(PARALLEL_MIN_ITEMS + 1);
        let machine_index = source.len();
        source.push(machine_entity(
            "serial-machine",
            "arc_smelter",
            "iron_ingot",
        ));
        let state = fixture_state(&source);
        let grids = renewable_power_grids(source.len());
        let machine_before = serde_json::to_vec(&source[machine_index]).unwrap();
        let (observed, _) = run_renewable_power_patches(&state, &source, &grids, 8);
        assert_eq!(
            serde_json::to_vec(&observed[machine_index]).unwrap(),
            machine_before,
            "non-renewable rows must remain on their established serial path",
        );
    }

    #[test]
    fn planet_metric_probe_is_compact_and_worker_threshold_is_explicit() {
        assert!(
            std::mem::size_of::<PlanetMetricProbe>() <= 32,
            "one full-factory probe row must remain a compact scalar result"
        );
        let runtime = DeterministicRuntime::for_test(8);
        let small = [7_usize, 3, 11, 5];
        let observed =
            collect_ordered_planet_metric_probes_with_runtime(&runtime, &small, |_, value| {
                Ok((*value, rayon::current_thread_index()))
            })
            .unwrap();
        assert_eq!(observed, vec![(7, None), (3, None), (11, None), (5, None)]);

        let large = (0..PARALLEL_MIN_ITEMS + 257).collect::<Vec<_>>();
        let observed = collect_ordered_planet_metric_probes_with_runtime(
            &DeterministicRuntime::for_test(4),
            &large,
            |index, value| {
                if index % 127 == 0 {
                    std::thread::yield_now();
                }
                Ok((*value, rayon::current_num_threads()))
            },
        )
        .unwrap();
        assert_eq!(
            observed.iter().map(|(value, _)| *value).collect::<Vec<_>>(),
            large
        );
        assert!(observed.iter().all(|(_, workers)| *workers == 4));
    }

    #[test]
    fn planet_metric_indexed_matches_true_flat_full_for_one_five_and_sixty_seconds() {
        for seconds in [1.0, 5.0, 60.0] {
            let indexed =
                run_planet_metric_oactive_advance(seconds, 4, PlanetMetricProbeMode::Indexed, None);
            let flat = run_planet_metric_oactive_advance(
                seconds,
                4,
                PlanetMetricProbeMode::FlatFull,
                None,
            );
            assert_eq!(indexed.bytes, flat.bytes, "entity/base bytes at {seconds}s");
            assert_eq!(indexed.canonical, flat.canonical, "canonical at {seconds}s");
            assert_eq!(indexed.domain, flat.domain, "domain at {seconds}s");
            assert_eq!(
                indexed.conservation, flat.conservation,
                "conservation at {seconds}s"
            );
            assert_eq!(indexed.selection_calls.0, seconds as usize);
            assert_eq!(indexed.selection_calls.1, 0);
            assert_eq!(flat.selection_calls.0, 0);
            assert_eq!(flat.selection_calls.1, seconds as usize);
            assert_eq!(indexed.scans[0].selected_rows, 1_024);
            assert!(indexed.scans[0].full_scan);
            assert!(
                indexed
                    .scans
                    .iter()
                    .skip(1)
                    .all(|scan| scan.selected_rows <= 1 && !scan.full_scan)
            );
            assert!(
                flat.scans
                    .iter()
                    .all(|scan| scan.selected_rows == 1_024 && scan.full_scan)
            );
        }
    }

    #[test]
    fn planet_metric_full_advance_is_identical_for_one_two_four_and_eight_workers() {
        let baseline =
            run_planet_metric_oactive_advance(5.0, 1, PlanetMetricProbeMode::FlatFull, None);
        for workers in [1, 2, 4, 8] {
            let indexed = run_planet_metric_oactive_advance(
                5.0,
                workers,
                PlanetMetricProbeMode::Indexed,
                None,
            );
            assert_eq!(indexed.bytes, baseline.bytes, "bytes for {workers} workers");
            assert_eq!(
                indexed.canonical, baseline.canonical,
                "canonical for {workers} workers"
            );
            assert_eq!(
                indexed.domain, baseline.domain,
                "domain for {workers} workers"
            );
            assert_eq!(
                indexed.conservation, baseline.conservation,
                "conservation for {workers} workers"
            );
        }
    }

    #[test]
    fn planet_metric_one_ten_and_thirty_second_steps_and_segmented_commits_match() {
        for (step_size, segments) in [
            (1.0, vec![1.0; 60]),
            (10.0, vec![10.0; 6]),
            (30.0, vec![30.0; 2]),
        ] {
            let mut long = planet_metric_oactive_fixture(1_024);
            let long_source_revision = long.revision;
            advance_planet_metric_test_state(&mut long, 60.0, step_size);

            let mut segmented = planet_metric_oactive_fixture(1_024);
            let segmented_source_revision = segmented.revision;
            for &seconds in &segments {
                advance_planet_metric_test_state(&mut segmented, seconds, step_size);
            }
            assert_eq!(long.revision, long_source_revision + 1);
            assert_eq!(
                segmented.revision,
                segmented_source_revision + segments.len() as u64
            );
            let context = format!("planet metric state diverged for {step_size}s internal steps");
            if step_size == 1.0 {
                assert_public_exact_state_equal_except_revision(
                    &long,
                    &segmented,
                    segments.len() as u64 - 1,
                    &context,
                );
            } else {
                assert_forced_legacy_step_state_equal_except_history_and_revision(
                    &long,
                    &segmented,
                    step_size,
                    segments.len(),
                    &context,
                );
            }
            let long_runtime = long.prepared_planet_metrics_runtime().unwrap();
            let segmented_runtime = segmented.prepared_planet_metrics_runtime().unwrap();
            assert_eq!(
                long_runtime.scan_history_for_test(),
                segmented_runtime.scan_history_for_test(),
                "{context}: runtime scan history"
            );
            assert_eq!(
                long_runtime.pending_rows_for_test(),
                segmented_runtime.pending_rows_for_test(),
                "{context}: pending rows"
            );
            assert_eq!(
                long_runtime.selection_calls_for_test(),
                segmented_runtime.selection_calls_for_test(),
                "{context}: indexed/full selection calls"
            );
            assert_eq!(
                long_runtime.scan_history_for_test().len(),
                (60.0 / step_size) as usize
            );
        }
    }

    #[test]
    fn planet_metric_same_length_topology_cow_and_exact_dense_threshold_use_full_scan() {
        let mut state = planet_metric_oactive_fixture(1_024);
        let entities = state.parse_entities_parallel().unwrap();
        let mut metric_runtime =
            std::sync::Arc::new(PlanetMetricsRuntime::build(&state, &entities));
        collect_planet_metrics_with_runtime(
            &DeterministicRuntime::for_test(4),
            &state,
            &entities,
            1,
            &mut metric_runtime,
            PlanetMetricProbeMode::Indexed,
        )
        .unwrap();
        assert!(metric_runtime.pending_rows_for_test().is_empty());

        // Merely taking a mutable topology reference must COW because the
        // runtime retains the former Arc. Length and capacity stay unchanged.
        let topology_len = state.factory_topology.entity_planet_indices.len();
        let topology_capacity = state.factory_topology.entity_planet_indices.capacity();
        let topology = std::sync::Arc::make_mut(&mut state.factory_topology);
        topology.entity_grid_indices[1] = if topology.entity_grid_indices[1] == 0 {
            1
        } else {
            0
        };
        assert_eq!(topology.entity_planet_indices.len(), topology_len);
        assert_eq!(topology.entity_planet_indices.capacity(), topology_capacity);
        std::sync::Arc::make_mut(&mut metric_runtime).wake_entity_indices(&[1]);
        collect_planet_metrics_with_runtime(
            &DeterministicRuntime::for_test(4),
            &state,
            &entities,
            1,
            &mut metric_runtime,
            PlanetMetricProbeMode::Indexed,
        )
        .unwrap();
        let drift = metric_runtime.scan_history_for_test().last().unwrap();
        assert!(drift.full_scan && drift.directory_fallback);
        assert_eq!(drift.selected_rows, 1_024);

        let state = planet_metric_oactive_fixture(1_024);
        let entities = state.parse_entities_parallel().unwrap();
        let mut dense_runtime = std::sync::Arc::new(PlanetMetricsRuntime::build(&state, &entities));
        collect_planet_metrics_with_runtime(
            &DeterministicRuntime::for_test(4),
            &state,
            &entities,
            1,
            &mut dense_runtime,
            PlanetMetricProbeMode::Indexed,
        )
        .unwrap();
        let dense_indices = (0..768).collect::<Vec<_>>();
        std::sync::Arc::make_mut(&mut dense_runtime).wake_entity_indices(&dense_indices);
        collect_planet_metrics_with_runtime(
            &DeterministicRuntime::for_test(4),
            &state,
            &entities,
            1,
            &mut dense_runtime,
            PlanetMetricProbeMode::Indexed,
        )
        .unwrap();
        let dense = dense_runtime.scan_history_for_test().last().unwrap();
        assert!(dense.full_scan && dense.dense_fallback);
        assert!(!dense.directory_fallback);
        assert_eq!(dense.selected_rows, 1_024);
    }

    #[test]
    fn planet_metric_opaque_and_malformed_shapes_stay_on_flat_full() {
        for malformed in [false, true] {
            let state = planet_metric_oactive_fixture(1_024);
            let mut entities = state.parse_entities_parallel().unwrap();
            if malformed {
                entities[17]["productionRate"] = Value::from("opaque-number");
            } else {
                entities[17]["mod:opaque"] = json!({"writer": true});
            }
            let mut metric_runtime =
                std::sync::Arc::new(PlanetMetricsRuntime::build(&state, &entities));
            for _ in 0..2 {
                collect_planet_metrics_with_runtime(
                    &DeterministicRuntime::for_test(4),
                    &state,
                    &entities,
                    1,
                    &mut metric_runtime,
                    PlanetMetricProbeMode::Indexed,
                )
                .unwrap();
            }
            assert!(metric_runtime.scan_history_for_test().iter().all(|scan| {
                scan.full_scan && scan.directory_fallback && scan.selected_rows == 1_024
            }));
        }

        let state = fixture_state_from_base_with_registry(
            construction_isolation_base(),
            &[json!({
                "id": "planet-metric-malformed-fuel",
                "kind": "power",
                "planetId": "home",
                "powerGridId": "grid-a",
                "buildingId": "thermal_power_plant",
                "fuelItemId": "coal",
                "fuelRemainingMj": 0,
                "machineCount": 1,
                "minerCount": 0,
                "inputs": { "coal": 1 },
                "outputs": {},
                "progress": 0,
                "utilization": 0,
                "productionRate": 0,
                "routingCursor": 0
            })],
            crate::command::EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT,
        );
        let mut entities = state.parse_entities_parallel().unwrap();
        entities[0]["inputs"]["coal"] = Value::from("opaque-number");
        let mut metric_runtime =
            std::sync::Arc::new(PlanetMetricsRuntime::build(&state, &entities));
        for _ in 0..2 {
            collect_planet_metrics_with_runtime(
                &DeterministicRuntime::for_test(4),
                &state,
                &entities,
                1,
                &mut metric_runtime,
                PlanetMetricProbeMode::Indexed,
            )
            .unwrap();
        }
        assert!(
            metric_runtime.scan_history_for_test().iter().all(|scan| {
                scan.full_scan && scan.directory_fallback && scan.selected_rows == 1
            })
        );
    }

    #[test]
    fn planet_metric_memory_estimate_is_a_conservative_peak_lower_bound() {
        let state = planet_metric_oactive_fixture(1_024);
        let entities = state.parse_entities_parallel().unwrap();
        let runtime = PlanetMetricsRuntime::build(&state, &entities);
        let rows = entities.len() as u64;
        let minimum_two_probe_buffers = rows * std::mem::size_of::<PlanetMetricProbe>() as u64 * 2;
        let minimum_full_selection = rows * std::mem::size_of::<usize>() as u64;
        assert!(
            runtime.estimated_bytes()
                >= minimum_two_probe_buffers.saturating_add(minimum_full_selection)
        );
        assert!(state.memory_estimate().topology_index_bytes >= runtime.estimated_bytes());
    }

    #[test]
    fn generic_entity_patch_invalidates_planet_metric_runtime() {
        let mut state = planet_metric_oactive_fixture(32);
        assert!(state.prepared_planet_metrics_runtime().is_some());
        assert!(state.prepared_power_probe_runtime().is_some());
        let entity_id = state.entities.ids[1].to_owned();
        let base_revision = state.revision;
        state
            .apply_command(&SimulationCommandPatch {
                protocol_version: crate::CORE_PROTOCOL_VERSION,
                base_revision,
                top_level_changes: Vec::new(),
                changed_entities: vec![RecordPatch {
                    id: entity_id,
                    changes: vec![ValuePatch {
                        path: vec![PathSegment::Key("productionRate".to_owned())],
                        operation: "set".to_owned(),
                        value: Some(Value::from(7.25)),
                    }],
                }],
                added_entities: Vec::new(),
                removed_entity_ids: Vec::new(),
                changed_belts: Vec::new(),
                added_belts: Vec::new(),
                removed_belt_ids: Vec::new(),
            })
            .unwrap();
        assert!(state.prepared_planet_metrics_runtime().is_none());
        assert!(state.prepared_power_probe_runtime().is_none());
    }

    #[test]
    fn planet_metric_public_advance_installs_the_committed_candidate_runtime() {
        let mut state = planet_metric_oactive_fixture(1_024);
        let source_runtime = state.prepared_planet_metrics_runtime().unwrap();
        let source_revision = state.revision;
        let first = state
            .advance(&CoreAdvanceRequest {
                base_revision: source_revision,
                simulation_seconds: 1.0,
                wall_seconds: 1.0,
                advance_mode: CoreAdvanceMode::Exact,
                include_diagnostics: false,
            })
            .unwrap();
        assert!(first.supported);
        assert_eq!(state.revision, source_revision + 1);
        let first_runtime = state.prepared_planet_metrics_runtime().unwrap();
        assert!(!std::sync::Arc::ptr_eq(&first_runtime, &source_runtime));
        assert!(
            first_runtime
                .scan_history_for_test()
                .last()
                .unwrap()
                .full_scan
        );

        let second = state
            .advance(&CoreAdvanceRequest {
                base_revision: state.revision,
                simulation_seconds: 1.0,
                wall_seconds: 1.0,
                advance_mode: CoreAdvanceMode::Exact,
                include_diagnostics: false,
            })
            .unwrap();
        assert!(second.supported);
        let second_runtime = state.prepared_planet_metrics_runtime().unwrap();
        assert!(!std::sync::Arc::ptr_eq(&second_runtime, &first_runtime));
        let scan = second_runtime.scan_history_for_test().last().unwrap();
        assert!(!scan.full_scan);
        // Static renewable display/settlement rows now sleep after the cold
        // calibration. With no dynamic entity writer in this fixture the
        // committed public advance still installs the next runtime, but its
        // planet-metric candidate correctly visits no entity rows.
        assert_eq!(scan.selected_rows, 0);
    }

    #[test]
    fn planet_metric_warm_cache_stays_sparse_after_pause_resume_revision_transitions() {
        let mut state = planet_metric_oactive_fixture(1_024);
        for _ in 0..2 {
            let result = state
                .advance(&CoreAdvanceRequest {
                    base_revision: state.revision,
                    simulation_seconds: 1.0,
                    wall_seconds: 1.0,
                    advance_mode: CoreAdvanceMode::Exact,
                    include_diagnostics: false,
                })
                .unwrap();
            assert!(result.supported);
        }
        assert!(
            !state
                .prepared_planet_metrics_runtime()
                .unwrap()
                .scan_history_for_test()
                .last()
                .unwrap()
                .full_scan
        );

        let pause_command = |base_revision, paused| SimulationCommandPatch {
            protocol_version: crate::CORE_PROTOCOL_VERSION,
            base_revision,
            top_level_changes: vec![ValuePatch {
                path: vec![PathSegment::Key("paused".to_owned())],
                operation: "set".to_owned(),
                value: Some(Value::from(paused)),
            }],
            changed_entities: Vec::new(),
            added_entities: Vec::new(),
            removed_entity_ids: Vec::new(),
            changed_belts: Vec::new(),
            added_belts: Vec::new(),
            removed_belt_ids: Vec::new(),
        };
        state
            .apply_player_authority_pause_transition(&pause_command(state.revision, true))
            .unwrap();
        state
            .apply_player_authority_pause_transition(&pause_command(state.revision, false))
            .unwrap();
        let scans_before = state
            .prepared_planet_metrics_runtime()
            .unwrap()
            .scan_history_for_test()
            .len();

        let result = state
            .advance(&CoreAdvanceRequest {
                base_revision: state.revision,
                simulation_seconds: 5.0,
                wall_seconds: 5.0,
                advance_mode: CoreAdvanceMode::Exact,
                include_diagnostics: false,
            })
            .unwrap();
        assert!(result.supported);
        let runtime = state.prepared_planet_metrics_runtime().unwrap();
        let resumed_scans = &runtime.scan_history_for_test()[scans_before..];
        assert_eq!(resumed_scans.len(), 5);
        assert!(resumed_scans.iter().all(|scan| !scan.full_scan));
        assert!(resumed_scans.iter().all(|scan| !scan.directory_fallback));
        assert!(resumed_scans.iter().all(|scan| scan.selected_rows <= 1));
    }

    #[test]
    fn planet_metric_outer_campaign_failure_keeps_the_source_runtime_and_state_atomic() {
        let mut state = planet_metric_oactive_fixture(1_024);
        state.base_value_mut().remove("campaign");
        let source_revision = state.revision;
        let source_fingerprint = planet_metric_state_fingerprint(&state);
        let source_runtime = state.prepared_planet_metrics_runtime().unwrap();
        let source_scans = source_runtime.scan_history_for_test().to_vec();
        let source_pending = source_runtime.pending_rows_for_test();
        let source_selection_calls = source_runtime.selection_calls_for_test();

        let error = state
            .advance(&CoreAdvanceRequest {
                base_revision: source_revision,
                simulation_seconds: 1.0,
                wall_seconds: 1.0,
                advance_mode: CoreAdvanceMode::Exact,
                include_diagnostics: false,
            })
            .unwrap_err();
        let error_chain = format!("{error:#}");
        assert!(
            error_chain.contains("native campaign state is missing"),
            "unexpected error chain: {error_chain}"
        );
        assert_eq!(state.revision, source_revision);
        assert_eq!(planet_metric_state_fingerprint(&state), source_fingerprint);
        let retained_runtime = state.prepared_planet_metrics_runtime().unwrap();
        assert!(std::sync::Arc::ptr_eq(&retained_runtime, &source_runtime));
        assert_eq!(retained_runtime.scan_history_for_test(), source_scans);
        assert_eq!(retained_runtime.pending_rows_for_test(), source_pending);
        assert_eq!(
            retained_runtime.selection_calls_for_test(),
            source_selection_calls
        );
    }

    #[test]
    fn planet_metric_failure_after_candidate_collect_leaves_source_bytes_hashes_and_runtime_unchanged()
     {
        let state = planet_metric_oactive_fixture(1_024);
        let source_fingerprint = planet_metric_state_fingerprint(&state);
        let source_runtime = state.prepared_planet_metrics_runtime().unwrap();
        let source_scans = source_runtime.scan_history_for_test().to_vec();
        let source_pending = source_runtime.pending_rows_for_test();
        let source_selection_calls = source_runtime.selection_calls_for_test();

        let error = match prepare_advance_with_planet_metric_test_options(
            &state,
            1.0,
            1.0,
            false,
            &DeterministicRuntime::for_test(4),
            PlanetMetricProbeMode::IndexedFailAfterCollect,
            None,
        ) {
            Ok(_) => panic!("injected post-collect failure unexpectedly succeeded"),
            Err(error) => error,
        };
        let error_chain = format!("{error:#}");
        assert!(
            error_chain.contains("injected failure after planet metric candidate collection"),
            "unexpected error chain: {error_chain}"
        );

        assert_eq!(planet_metric_state_fingerprint(&state), source_fingerprint);
        let retained_runtime = state.prepared_planet_metrics_runtime().unwrap();
        assert!(std::sync::Arc::ptr_eq(&retained_runtime, &source_runtime));
        assert_eq!(retained_runtime.scan_history_for_test(), source_scans);
        assert_eq!(retained_runtime.pending_rows_for_test(), source_pending);
        assert_eq!(
            retained_runtime.selection_calls_for_test(),
            source_selection_calls
        );
    }

    #[test]
    fn planet_metric_post_barrier_material_writer_stays_pending_for_the_next_step() {
        let mut indexed = material_delivery_sparse_output_belt_fixture(64);
        let hub_index = indexed.factory_topology.material_delivery_hub_indices[0];
        let cold = prepare_advance_with_planet_metric_test_options(
            &indexed,
            1.0,
            1.0,
            false,
            &DeterministicRuntime::for_test(4),
            PlanetMetricProbeMode::Indexed,
            Some(1.0),
        )
        .unwrap();
        assert!(
            cold.planet_metrics_runtime
                .pending_rows_for_test()
                .contains(&hub_index)
        );
        assert!(
            cold.planet_metrics_runtime
                .scan_history_for_test()
                .last()
                .unwrap()
                .full_scan
        );
        commit_and_install_factory_test_state(&mut indexed, cold);

        let mut flat = indexed.clone();
        let indexed_next = prepare_advance_with_planet_metric_test_options(
            &indexed,
            1.0,
            1.0,
            false,
            &DeterministicRuntime::for_test(4),
            PlanetMetricProbeMode::Indexed,
            Some(1.0),
        )
        .unwrap();
        let indexed_scan = *indexed_next
            .planet_metrics_runtime
            .scan_history_for_test()
            .last()
            .unwrap();
        assert!(!indexed_scan.full_scan, "unexpected scan: {indexed_scan:?}");
        assert!(indexed_scan.selected_rows > 0);
        assert!(indexed_scan.selected_rows < indexed_scan.total_rows);

        let flat_next = prepare_advance_with_planet_metric_test_options(
            &flat,
            1.0,
            1.0,
            false,
            &DeterministicRuntime::for_test(4),
            PlanetMetricProbeMode::FlatFull,
            Some(1.0),
        )
        .unwrap();
        commit_and_install_factory_test_state(&mut indexed, indexed_next);
        commit_and_install_factory_test_state(&mut flat, flat_next);
        assert_eq!(
            planet_metric_state_fingerprint(&indexed),
            planet_metric_state_fingerprint(&flat)
        );
    }

    #[test]
    fn planet_metric_correctness_gate_precedes_synthetic_ab_evidence() {
        let state = planet_metric_oactive_fixture(16_384);
        let mut entities = state.parse_entities_parallel().unwrap();
        let deterministic_runtime = DeterministicRuntime::for_test(8);
        let mut indexed_runtime =
            std::sync::Arc::new(PlanetMetricsRuntime::build(&state, &entities));
        let mut flat_runtime = std::sync::Arc::new(PlanetMetricsRuntime::build(&state, &entities));
        let bits = |result: &(Vec<f64>, Vec<PlanetPowerReserves>)| {
            (
                result
                    .0
                    .iter()
                    .map(|value| value.to_bits())
                    .collect::<Vec<_>>(),
                result
                    .1
                    .iter()
                    .map(|value| {
                        [
                            value.0.to_bits(),
                            value.1.to_bits(),
                            value.2.to_bits(),
                            value.3.to_bits(),
                        ]
                    })
                    .collect::<Vec<_>>(),
            )
        };
        let warm_indexed = collect_planet_metrics_with_runtime(
            &deterministic_runtime,
            &state,
            &entities,
            1,
            &mut indexed_runtime,
            PlanetMetricProbeMode::Indexed,
        )
        .unwrap();
        let warm_flat = collect_planet_metrics_with_runtime(
            &deterministic_runtime,
            &state,
            &entities,
            1,
            &mut flat_runtime,
            PlanetMetricProbeMode::FlatFull,
        )
        .unwrap();
        assert_eq!(bits(&warm_indexed), bits(&warm_flat));

        let mut indexed_micros = Vec::new();
        let mut flat_micros = Vec::new();
        for round in 0..9_usize {
            let changed_index = 8_192;
            entities[changed_index]["productionRate"] = Value::from(round as f64 * 0.125);
            std::sync::Arc::make_mut(&mut indexed_runtime).wake_entity_indices(&[changed_index]);
            let mut measure_indexed = || {
                let started = std::time::Instant::now();
                let result = collect_planet_metrics_with_runtime(
                    &deterministic_runtime,
                    &state,
                    std::hint::black_box(&entities),
                    1,
                    &mut indexed_runtime,
                    PlanetMetricProbeMode::Indexed,
                )
                .unwrap();
                (started.elapsed().as_micros(), result)
            };
            let mut measure_flat = || {
                let started = std::time::Instant::now();
                let result = collect_planet_metrics_with_runtime(
                    &deterministic_runtime,
                    &state,
                    std::hint::black_box(&entities),
                    1,
                    &mut flat_runtime,
                    PlanetMetricProbeMode::FlatFull,
                )
                .unwrap();
                (started.elapsed().as_micros(), result)
            };
            let ((indexed_elapsed, indexed), (flat_elapsed, flat)) = if round.is_multiple_of(2) {
                (measure_indexed(), measure_flat())
            } else {
                let flat = measure_flat();
                let indexed = measure_indexed();
                (indexed, flat)
            };
            assert_eq!(bits(&indexed), bits(&flat), "A/B round {round}");
            indexed_micros.push(indexed_elapsed);
            flat_micros.push(flat_elapsed);
        }
        indexed_micros.sort_unstable();
        flat_micros.sort_unstable();
        let indexed_probe_rows = indexed_runtime
            .scan_history_for_test()
            .iter()
            .skip(1)
            .map(|scan| scan.selected_rows)
            .sum::<usize>();
        let flat_probe_rows = flat_runtime
            .scan_history_for_test()
            .iter()
            .skip(1)
            .map(|scan| scan.selected_rows)
            .sum::<usize>();
        assert_eq!(indexed_probe_rows, 9);
        assert_eq!(flat_probe_rows, 9 * entities.len());
        eprintln!(
            "DSP_NATIVE_CORE_PROFILE\tplanet-metric-oactive-pre-gate-ab\tentities={}\trounds=9\tindexed-probe-rows={}\tflat-probe-rows={}\tindexed-median-us={}\tflat-median-us={}\tclaim=synthetic-pre-gate-evidence-only",
            entities.len(),
            indexed_probe_rows,
            flat_probe_rows,
            indexed_micros[indexed_micros.len() / 2],
            flat_micros[flat_micros.len() / 2],
        );
    }

    #[test]
    fn planet_metrics_are_bit_exact_for_one_two_four_and_eight_workers() {
        let (state, entities) = planet_metric_fixture(PARALLEL_MIN_ITEMS + 73);
        let bits = |result: &(Vec<f64>, Vec<PlanetPowerReserves>)| {
            (
                result
                    .0
                    .iter()
                    .map(|value| value.to_bits())
                    .collect::<Vec<_>>(),
                result
                    .1
                    .iter()
                    .map(|values| {
                        [
                            values.0.to_bits(),
                            values.1.to_bits(),
                            values.2.to_bits(),
                            values.3.to_bits(),
                        ]
                    })
                    .collect::<Vec<_>>(),
            )
        };
        let baseline = serial_planet_metrics_oracle(&state, &entities, 1).unwrap();
        let baseline_bits = bits(&baseline);
        assert!(baseline.1[0].0 > 0.0);
        assert!(baseline.1[0].1 > baseline.1[0].0);
        assert!(baseline.1[0].2 > 0.0);
        assert!(baseline.1[0].3 > 0.0);
        for worker_count in [1, 2, 4, 8] {
            let mut metric_runtime =
                std::sync::Arc::new(PlanetMetricsRuntime::build(&state, &entities));
            let observed = collect_planet_metrics_with_runtime(
                &DeterministicRuntime::for_test(worker_count),
                &state,
                &entities,
                1,
                &mut metric_runtime,
                PlanetMetricProbeMode::Indexed,
            )
            .unwrap();
            assert_eq!(
                bits(&observed),
                baseline_bits,
                "planet metric fold diverged for {worker_count} workers"
            );
        }

        if std::env::var_os("DSP_NATIVE_CORE_PROFILE").is_some() {
            let (profile_state, profile_entities) = planet_metric_fixture(80_000);
            let runtime = DeterministicRuntime::for_test(8);
            let mut serial_ms = Vec::new();
            let mut parallel_ms = Vec::new();
            for round in 0_usize..9 {
                let measure_serial = || {
                    let started = std::time::Instant::now();
                    let result = serial_planet_metrics_oracle(
                        &profile_state,
                        std::hint::black_box(&profile_entities),
                        1,
                    )
                    .unwrap();
                    (started.elapsed().as_secs_f64() * 1_000.0, result)
                };
                let measure_parallel = || {
                    let mut metric_runtime = std::sync::Arc::new(PlanetMetricsRuntime::build(
                        &profile_state,
                        &profile_entities,
                    ));
                    let started = std::time::Instant::now();
                    let result = collect_planet_metrics_with_runtime(
                        &runtime,
                        &profile_state,
                        std::hint::black_box(&profile_entities),
                        1,
                        &mut metric_runtime,
                        PlanetMetricProbeMode::Indexed,
                    )
                    .unwrap();
                    (started.elapsed().as_secs_f64() * 1_000.0, result)
                };
                let ((serial_elapsed, serial), (parallel_elapsed, parallel)) =
                    if round.is_multiple_of(2) {
                        (measure_serial(), measure_parallel())
                    } else {
                        let parallel = measure_parallel();
                        let serial = measure_serial();
                        (serial, parallel)
                    };
                serial_ms.push(serial_elapsed);
                parallel_ms.push(parallel_elapsed);
                assert_eq!(bits(&parallel), bits(&serial), "profile round {round}");
            }
            serial_ms.sort_by(f64::total_cmp);
            parallel_ms.sort_by(f64::total_cmp);
            eprintln!(
                "DSP_NATIVE_CORE_PROFILE\tplanet-metric-ab\tentities=80000\trounds=9\tserial-median-ms={:.3}\tparallel-8-median-ms={:.3}",
                serial_ms[serial_ms.len() / 2],
                parallel_ms[parallel_ms.len() / 2]
            );
        }
    }

    #[test]
    fn planet_metric_failure_uses_lowest_entity_and_keeps_sources_atomic() {
        let (state, mut entities) = planet_metric_fixture(PARALLEL_MIN_ITEMS + 31);
        let later_failure = PARALLEL_MIN_ITEMS + 13;
        entities[7]["buildingId"] = Value::from("mod:missing-power/first");
        entities[later_failure]["buildingId"] = Value::from("mod:missing-power/later");
        let entity_bytes = serde_json::to_vec(&entities).unwrap();
        let state_hash = state.canonical_sha256().unwrap();
        for worker_count in [1, 2, 4, 8] {
            let mut metric_runtime =
                std::sync::Arc::new(PlanetMetricsRuntime::build(&state, &entities));
            let source_metric_runtime = metric_runtime.clone();
            let error = collect_planet_metrics_with_runtime(
                &DeterministicRuntime::for_test(worker_count),
                &state,
                &entities,
                1,
                &mut metric_runtime,
                PlanetMetricProbeMode::Indexed,
            )
            .unwrap_err();
            assert_eq!(
                error.to_string(),
                "native power reserve building is missing"
            );
            assert_eq!(serde_json::to_vec(&entities).unwrap(), entity_bytes);
            assert_eq!(state.canonical_sha256().unwrap(), state_hash);
            assert!(std::sync::Arc::ptr_eq(
                &metric_runtime,
                &source_metric_runtime
            ));
        }

        let values = (0..PARALLEL_MIN_ITEMS + 31).collect::<Vec<_>>();
        let visited_later_failure = AtomicBool::new(false);
        let error = collect_ordered_planet_metric_probes_with_runtime(
            &DeterministicRuntime::for_test(8),
            &values,
            |index, _| {
                if index == later_failure {
                    visited_later_failure.store(true, AtomicOrdering::SeqCst);
                    return Err(anyhow!("later-{index}"));
                }
                if index == 7 {
                    return Err(anyhow!("first-{index}"));
                }
                Ok(index)
            },
        )
        .unwrap_err();
        assert_eq!(error.to_string(), "first-7");
        assert!(visited_later_failure.load(AtomicOrdering::SeqCst));
    }

    #[test]
    fn vein_settlement_is_byte_exact_for_one_two_four_and_eight_workers() {
        let source = vein_matrix(PARALLEL_MIN_ITEMS + 47);
        let state = fixture_state(&source);
        let baseline = run_vein_matrix(&state, &source, 1);
        let baseline_bytes = serde_json::to_vec(&baseline.0).unwrap();
        let baseline_hash = fixture_checksum(&baseline_bytes);
        assert_eq!(baseline_hash, "09403e1f");
        for worker_count in [2, 4, 8] {
            let observed = run_vein_matrix(&state, &source, worker_count);
            let observed_bytes = serde_json::to_vec(&observed.0).unwrap();
            assert_eq!(
                fixture_checksum(&observed_bytes),
                baseline_hash,
                "vein result hash diverged for {worker_count} workers"
            );
            assert_eq!(
                observed_bytes, baseline_bytes,
                "vein entity bytes diverged for {worker_count} workers"
            );
            assert_eq!(observed.1, baseline.1);
            assert_eq!(observed.2, baseline.2);
        }
        assert_eq!(baseline.2, (0..source.len()).collect::<Vec<_>>());
        assert!(baseline.1.get("iron_ore").copied().unwrap_or(0.0) > 0.0);

        let noop = baseline.0[0].as_object().unwrap();
        assert_eq!(finite_number(noop.get("utilization")), -1.0);
        let full = baseline.0[1].as_object().unwrap();
        assert_eq!(finite_number(full.get("progress")), 0.0);
        assert_eq!(finite_number(full.get("productionRate")), 0.0);
        let depleted = baseline.0[2].as_object().unwrap();
        assert_eq!(finite_number(depleted.get("utilization")), 0.0);
        assert!(
            finite_number(baseline.0[4].get("resourceRemaining"))
                < finite_number(source[4].get("resourceRemaining"))
        );
        for (before, after) in source.iter().zip(&baseline.0) {
            assert_eq!(
                serde_json::to_vec(&before["mod:vein/opaque"]).unwrap(),
                serde_json::to_vec(&after["mod:vein/opaque"]).unwrap(),
                "parallel vein settlement changed an opaque MOD field"
            );
        }
    }

    #[test]
    fn vein_settlement_failure_is_ordered_atomic_and_waits_for_all_probes() {
        let source = vein_matrix(PARALLEL_MIN_ITEMS + 31);
        let state = fixture_state(&source);
        let state_hash = state.canonical_sha256().unwrap();
        let profiles = [fixture_profile()];
        let mut grids = vec![GridRuntime::default(); GRID_IDS.len()];
        grids[0].has_power_source = true;
        let power_factors = vein_power_factors(source.len());
        let output_credits = crate::belts::OutputCredits::default();
        let mut malformed = source.clone();
        malformed[7].as_object_mut().unwrap().remove("resourceId");
        let later_failure = PARALLEL_MIN_ITEMS + 13;
        malformed[later_failure]["resourceId"] = Value::from("mod:missing-resource/Ω");
        let malformed_bytes = serde_json::to_vec(&malformed).unwrap();

        for worker_count in [1, 2, 4, 8] {
            let visited_later_failure = AtomicBool::new(false);
            let environment = VeinProbeEnvironment {
                state: &state,
                entities: &malformed,
                profiles: &profiles,
                grids: &grids,
                power_factors: &power_factors,
                output_credits: &output_credits,
                context: finite_vein_context(),
            };
            let outcomes = collect_vein_settlement_outcomes_with_runtime(
                &DeterministicRuntime::for_test(worker_count),
                &state.factory_topology.vein_indices,
                |entity_index| {
                    if entity_index == later_failure {
                        visited_later_failure.store(true, AtomicOrdering::SeqCst);
                    }
                    probe_vein_settlement(&environment, entity_index)
                },
            );
            let failures = outcomes
                .iter()
                .filter_map(|outcome| {
                    outcome
                        .result
                        .as_ref()
                        .err()
                        .map(|error| (outcome.entity_index, error.to_string()))
                })
                .collect::<Vec<_>>();
            assert_eq!(
                failures,
                vec![
                    (
                        7,
                        "native simple factory vein resource is missing".to_owned()
                    ),
                    (
                        later_failure,
                        "native simple factory vein item catalog is missing".to_owned()
                    )
                ]
            );
            let lowest = outcomes
                .into_iter()
                .find_map(|outcome| outcome.result.err())
                .expect("malformed vein matrix must fail");
            assert_eq!(
                lowest.to_string(),
                "native simple factory vein resource is missing"
            );
            assert!(visited_later_failure.load(AtomicOrdering::SeqCst));
            assert_eq!(serde_json::to_vec(&malformed).unwrap(), malformed_bytes);
            assert_eq!(state.canonical_sha256().unwrap(), state_hash);
        }
    }

    #[test]
    fn zero_miner_vein_still_validates_topology_before_noop() {
        let source = vec![vein_entity(0)];
        let mut state = fixture_state(&source);
        std::sync::Arc::make_mut(&mut state.factory_topology).entity_planet_indices[0] = usize::MAX;
        let profiles = [fixture_profile()];
        let grids = vec![GridRuntime::default(); GRID_IDS.len()];
        let output_credits = crate::belts::OutputCredits::default();
        let source_bytes = serde_json::to_vec(&source).unwrap();
        let result = probe_vein_settlement(
            &VeinProbeEnvironment {
                state: &state,
                entities: &source,
                profiles: &profiles,
                grids: &grids,
                power_factors: &HashMap::new(),
                output_credits: &output_credits,
                context: finite_vein_context(),
            },
            0,
        );

        assert_eq!(
            result.unwrap_err().to_string(),
            "native simple factory entity topology is unknown"
        );
        assert_eq!(serde_json::to_vec(&source).unwrap(), source_bytes);
    }

    #[test]
    fn small_vein_probe_batches_stay_serial() {
        let indices = (0..31).collect::<Vec<_>>();
        let saw_rayon_worker = AtomicBool::new(false);
        let outcomes = collect_vein_settlement_outcomes_with_runtime(
            &DeterministicRuntime::for_test(8),
            &indices,
            |_| {
                if rayon::current_thread_index().is_some() {
                    saw_rayon_worker.store(true, AtomicOrdering::SeqCst);
                }
                Ok(VeinSettlementDelta::Noop)
            },
        );
        assert_eq!(
            outcomes
                .iter()
                .map(|outcome| outcome.entity_index)
                .collect::<Vec<_>>(),
            indices
        );
        assert!(outcomes.iter().all(|outcome| outcome.result.is_ok()));
        assert!(!saw_rayon_worker.load(AtomicOrdering::SeqCst));
    }

    #[test]
    fn infinite_vein_probe_never_depletes_the_persisted_resource_fields() {
        let mut source = vec![vein_entity(5)];
        source[0]["resourceRemaining"] = Value::from(0);
        source[0]["resourceDepletionRemainder"] = Value::from(7);
        source[0]["outputs"]["iron_ore"] = Value::from(0);
        let state = fixture_state(&source);
        let profiles = [fixture_profile()];
        let mut grids = vec![GridRuntime::default(); GRID_IDS.len()];
        grids[0].has_power_source = true;
        let output_credits = crate::belts::OutputCredits::default();
        let mut context = finite_vein_context();
        context.infinite_resource_mode = true;
        let outcome = collect_vein_settlement_outcomes(
            &DeterministicRuntime::for_test(8),
            &state.factory_topology.vein_indices,
            &VeinProbeEnvironment {
                state: &state,
                entities: &source,
                profiles: &profiles,
                grids: &grids,
                power_factors: &HashMap::new(),
                output_credits: &output_credits,
                context,
            },
        )
        .into_iter()
        .next()
        .unwrap();
        let mut candidate = source.clone();
        let production = replay_vein_settlement(&mut candidate[0], outcome.result.unwrap())
            .unwrap()
            .expect("infinite vein must remain productive");
        assert!(production.1 > 0.0);
        assert_eq!(candidate[0]["resourceRemaining"], Value::from(0));
        assert_eq!(candidate[0]["resourceDepletionRemainder"], Value::from(7));
    }

    #[test]
    fn local_machine_settlement_excludes_every_global_recipe() {
        assert!(is_local_machine_settlement_recipe("iron_ingot"));
        assert!(!is_local_machine_settlement_recipe("matrix_research"));
        assert!(!is_local_machine_settlement_recipe("solar_sail_launch"));
        assert!(!is_local_machine_settlement_recipe("carrier_rocket_launch"));
        assert!(
            std::mem::size_of::<MachineLocalSettlementDelta>()
                <= (MAX_PARALLEL_LOCAL_MACHINE_OUTPUTS + 1) * std::mem::size_of::<f64>(),
            "local settlement result must remain an allocation-free scalar slot"
        );
    }

    #[test]
    fn local_machine_full_settlement_is_exact_for_one_two_four_and_eight_workers() {
        let source = local_machine_matrix(PARALLEL_MIN_ITEMS + 33);
        let state = fixture_state(&source);
        let baseline = run_local_machine_matrix(&state, &source, 1);
        for worker_count in [2, 4, 8] {
            let observed = run_local_machine_matrix(&state, &source, worker_count);
            assert_eq!(
                serde_json::to_vec(&observed.0).unwrap(),
                serde_json::to_vec(&baseline.0).unwrap(),
                "entity bytes diverged for {worker_count} workers"
            );
            assert_eq!(observed.1, baseline.1);
            assert_eq!(observed.2, baseline.2);
        }
        assert_eq!(baseline.2, (0..source.len()).collect::<Vec<_>>());
        assert!(baseline.1.get("iron_ingot").copied().unwrap_or(0.0) > 0.0);

        let extra = baseline.0[0].as_object().unwrap();
        assert_eq!(finite_number(extra.get("proliferatorPoints")), 3.0);
        assert_eq!(number_at(extra.get("outputs"), &["iron_ingot"]), 2.0);
        let blocked = baseline.0[2].as_object().unwrap();
        assert_eq!(finite_number(blocked.get("progress")), 0.25);
        assert_eq!(finite_number(blocked.get("productionRate")), 0.0);
        let unpowered = baseline.0[3].as_object().unwrap();
        assert_eq!(finite_number(unpowered.get("progress")), 0.25);
        assert_eq!(finite_number(unpowered.get("utilization")), 0.0);
        let locked = baseline.0[4].as_object().unwrap();
        assert_eq!(finite_number(locked.get("progress")), 0.0);
        assert_eq!(number_at(locked.get("outputs"), &["iron_ingot"]), 0.0);

        for (before, after) in source.iter().zip(&baseline.0) {
            assert_eq!(
                serde_json::to_string(&before["mod:unknown"]).unwrap(),
                serde_json::to_string(&after["mod:unknown"]).unwrap(),
                "parallel settlement changed an unknown MOD field"
            );
        }
    }

    #[test]
    fn global_recipes_remain_barriers_while_local_groups_share_one_batch() {
        let entities = vec![
            machine_entity("local-0", "arc_smelter", "iron_ingot"),
            machine_entity("local-1", "arc_smelter", "iron_ingot"),
            machine_entity("research", "matrix_lab", "matrix_research"),
            machine_entity("local-2", "arc_smelter", "iron_ingot"),
            machine_entity("local-3", "arc_smelter", "iron_ingot"),
            machine_entity("sail", "em_rail_ejector", "solar_sail_launch"),
            machine_entity("local-4", "arc_smelter", "iron_ingot"),
            machine_entity("local-5", "arc_smelter", "iron_ingot"),
            machine_entity("rocket", "vertical_launching_silo", "carrier_rocket_launch"),
            machine_entity("local-6", "arc_smelter", "iron_ingot"),
            machine_entity("local-7", "arc_smelter", "iron_ingot"),
            machine_entity("wide-mod", "arc_smelter", "mod:wide-output"),
        ];
        let state = fixture_state(&entities);
        let parallel = plan_local_machine_settlement_with_threshold(
            &state,
            &DeterministicRuntime::for_test(8),
            &state.factory_topology.ordinary_machine_indices,
            2,
        );
        assert_eq!(parallel.global_barrier_count, 3);
        assert_eq!(parallel.parallel_entity_count, 8);
        assert_eq!(parallel.serial_fallback_count, 1);
        assert_eq!(
            parallel
                .batches
                .iter()
                .map(|batch| batch.entity_indices.clone())
                .collect::<Vec<_>>(),
            vec![vec![0, 1, 3, 4, 6, 7, 9, 10]]
        );

        let production_threshold = plan_local_machine_settlement(
            &state,
            &DeterministicRuntime::for_test(8),
            &state.factory_topology.ordinary_machine_indices,
        );
        assert!(production_threshold.batches.is_empty());
        assert_eq!(production_threshold.serial_fallback_count, 9);
        assert_eq!(production_threshold.global_barrier_count, 3);

        let one_worker = plan_local_machine_settlement_with_threshold(
            &state,
            &DeterministicRuntime::for_test(1),
            &state.factory_topology.ordinary_machine_indices,
            2,
        );
        assert!(one_worker.batches.is_empty());
        assert_eq!(one_worker.serial_fallback_count, 9);
        assert_eq!(one_worker.global_barrier_count, 3);
    }

    #[test]
    fn production_shape_crosses_small_groups_and_is_exact_for_all_worker_limits() {
        let local_count = PARALLEL_MIN_ITEMS + 137;
        let mut entities = Vec::with_capacity(local_count + local_count / 37);
        for local_index in 0..local_count {
            if local_index > 0 && local_index % 37 == 0 {
                entities.push(machine_entity(
                    format!("research-{local_index:05}"),
                    "matrix_lab",
                    "matrix_research",
                ));
            }
            entities.push(machine_entity(
                format!("local-{local_index:05}"),
                "arc_smelter",
                if local_index % 11 == 0 {
                    "locked_ingot"
                } else {
                    "iron_ingot"
                },
            ));
        }
        let state = fixture_state(&entities);
        let plan = plan_local_machine_settlement(
            &state,
            &DeterministicRuntime::for_test(8),
            &state.factory_topology.ordinary_machine_indices,
        );
        assert_eq!(plan.batches.len(), 1);
        assert_eq!(plan.parallel_entity_count, local_count);
        assert!(plan.global_barrier_count > 100);
        assert_eq!(plan.serial_fallback_count, 0);
        let candidate_indices = plan.batches[0].entity_indices.clone();

        let run = |worker_count| {
            let mut candidate = entities.clone();
            let base = fixture_base();
            let outcomes = execute_local_machine_settlement_batch_with_runtime(
                &DeterministicRuntime::for_test(worker_count),
                &state,
                base.as_object().unwrap(),
                &mut candidate,
                MachineLocalSettlementBatch {
                    entity_indices: candidate_indices.clone(),
                },
                &[fixture_profile()],
                &HashMap::new(),
                &crate::belts::OutputCredits::default(),
                DEFAULT_BUILDING_BUFFER_LIMIT,
                1.0,
            );
            let mut produced = HashMap::new();
            for outcome in outcomes {
                merge_local_machine_production(&state, outcome, &mut produced).unwrap();
            }
            let bytes = serde_json::to_vec(&candidate).unwrap();
            (fixture_checksum(&bytes), bytes, produced)
        };

        let baseline = run(1);
        for worker_count in [2, 4, 8] {
            let observed = run(worker_count);
            assert_eq!(
                observed.0, baseline.0,
                "hash diverged for {worker_count} workers"
            );
            assert_eq!(
                observed.1, baseline.1,
                "effects diverged for {worker_count} workers"
            );
            assert_eq!(
                observed.2, baseline.2,
                "production diverged for {worker_count} workers"
            );
        }
    }

    #[test]
    fn local_settlement_reads_the_current_post_barrier_technology_snapshot() {
        let source = vec![machine_entity(
            "locked-machine",
            "arc_smelter",
            "locked_ingot",
        )];
        let state = fixture_state(&source);
        let mut locked = source[0].clone();
        let locked_base = fixture_base();
        let locked_delta = settle_parallel_local_machine(
            &state,
            local_machine_settlement_context(&state, locked_base.as_object().unwrap(), 0).unwrap(),
            0,
            &mut locked,
            &[fixture_profile()],
            &HashMap::new(),
            &crate::belts::OutputCredits::default(),
            DEFAULT_BUILDING_BUFFER_LIMIT,
            1.0,
        )
        .unwrap();
        assert_eq!(locked_delta.produced_len, 0);
        assert_eq!(finite_number(locked.get("progress")), 0.0);

        let mut unlocked_base = fixture_base();
        unlocked_base["research"]["completedTechIds"] = json!(["proliferator_1", "locked_tech"]);
        let mut unlocked = source[0].clone();
        let unlocked_delta = settle_parallel_local_machine(
            &state,
            local_machine_settlement_context(&state, unlocked_base.as_object().unwrap(), 0)
                .unwrap(),
            0,
            &mut unlocked,
            &[fixture_profile()],
            &HashMap::new(),
            &crate::belts::OutputCredits::default(),
            DEFAULT_BUILDING_BUFFER_LIMIT,
            1.0,
        )
        .unwrap();
        assert_eq!(unlocked_delta.produced_len, 1);
        assert!(unlocked_delta.produced[0] >= 1.0);
    }

    #[test]
    fn parallel_failures_restore_every_candidate_slot_and_choose_the_lowest_index() {
        let source = local_machine_matrix(PARALLEL_MIN_ITEMS + 33);
        let state = fixture_state(&source);
        let source_bytes = serde_json::to_vec(&state.parse_entities_parallel().unwrap()).unwrap();
        let mut candidate = source.clone();
        let second_failure = PARALLEL_MIN_ITEMS + 7;
        candidate[17]["outputs"] = Value::Null;
        candidate[second_failure]["proliferatorBonusProgress"] = Value::Null;
        let entity_indices = state.factory_topology.ordinary_machine_indices.clone();
        let base = fixture_base();
        let outcomes = execute_local_machine_settlement_batch_with_runtime(
            &DeterministicRuntime::for_test(8),
            &state,
            base.as_object().unwrap(),
            &mut candidate,
            MachineLocalSettlementBatch { entity_indices },
            &[fixture_profile()],
            &matrix_power_factors(source.len()),
            &crate::belts::OutputCredits::default(),
            DEFAULT_BUILDING_BUFFER_LIMIT,
            1.0,
        );
        assert!(candidate.iter().all(Value::is_object));
        let failures = outcomes
            .iter()
            .filter_map(|outcome| {
                outcome
                    .result
                    .as_ref()
                    .err()
                    .map(|error| (outcome.entity_index, error.to_string()))
            })
            .collect::<Vec<_>>();
        assert_eq!(
            failures.iter().map(|(index, _)| *index).collect::<Vec<_>>(),
            vec![17, second_failure]
        );
        assert_eq!(
            failures[0].1,
            "native simple factory machine outputs are missing"
        );
        assert_eq!(
            failures[1].1,
            "native simple factory bonus record is missing"
        );
        let mut produced = HashMap::new();
        let lowest_error = outcomes
            .into_iter()
            .find_map(|outcome| {
                merge_local_machine_production(&state, outcome, &mut produced).err()
            })
            .expect("faulty parallel settlement should fail replay");
        assert_eq!(
            lowest_error.to_string(),
            "native simple factory machine outputs are missing"
        );
        assert_eq!(
            serde_json::to_vec(&state.parse_entities_parallel().unwrap()).unwrap(),
            source_bytes,
            "failed candidate settlement mutated the live CoreState"
        );
    }

    #[test]
    fn machine_production_merge_replays_original_entity_order_without_worker_reduction() {
        let source = vec![
            machine_entity("machine-0", "arc_smelter", "iron_ingot"),
            machine_entity("machine-1", "arc_smelter", "iron_ingot"),
            machine_entity("machine-2", "arc_smelter", "iron_ingot"),
        ];
        let state = fixture_state(&source);
        let mut produced = HashMap::new();
        for (entity_index, value) in [10_000_000_000_000_000.0, 1.0, 1.0].into_iter().enumerate() {
            let mut delta = MachineLocalSettlementDelta::default();
            delta.produced[0] = value;
            delta.produced_len = 1;
            merge_local_machine_production(
                &state,
                MachineLocalSettlementOutcome {
                    entity_index,
                    result: Ok(delta),
                },
                &mut produced,
            )
            .unwrap();
        }
        let serial = ((0.0 + 10_000_000_000_000_000.0) + 1.0) + 1.0;
        let grouped = 10_000_000_000_000_000.0 + (1.0 + 1.0);
        assert_eq!(produced["iron_ingot"], serial);
        assert_ne!(produced["iron_ingot"], grouped);
    }

    #[test]
    fn route_advance_post_route_ledger_boundary_and_cache_refresh_share_production_chain() {
        let slot = |remote_mode: &str| {
            json!({
                "itemId": if remote_mode == "storage" { Value::Null } else { Value::from("iron_ore") },
                "localMode": "storage",
                "remoteMode": remote_mode,
                "minimumLoad": 0.1,
                "minStock": 0,
                "maxStock": 1000000,
                "priority": 1,
                "routePolicy": "direct",
                "warperBudget": 0
            })
        };
        let station = |id: &str, tier: u64, transition: Option<&str>, remote_mode: &str| {
            json!({
                "id": id,
                "kind": "station",
                "planetId": "home",
                "powerGridId": "grid-a",
                "buildingId": "interstellar_logistics_station",
                "stationTier": tier,
                "stationOperationMode": "legacy",
                "stationModeTransition": transition,
                "machineCount": 1,
                "stationSlots": [
                    slot(remote_mode), slot("storage"), slot("storage"), slot("storage"), slot("storage")
                ],
                "stationRoutes": [],
                "stationVessels": 2,
                "stationWarpEnabled": false,
                "stationWarpers": 0,
                "stationDispatchCursor": 0,
                "stationLastSupplyPeerBySlot": {},
                "stationProgress": 0,
                "stationCongestion": 0,
                "stationTrips": 0,
                "stationLastTransfer": 0,
                "inputs": { "iron_ore": 0 },
                "outputs": { "iron_ore": 1 },
                "utilization": 0,
                "productionRate": 0,
                "routingCursor": 0
            })
        };
        let mut entities = vec![
            station("transition-target", 2, Some("to-elevator"), "supply"),
            station("route-demand", 1, None, "demand"),
        ];
        entities[1]["stationRoutes"] = json!([{
            "id": "draining-remote-route",
            "slotIndex": 0,
            "peerId": "transition-target",
            "itemId": "iron_ore",
            "scope": "remote",
            "cargo": 1,
            "vehicleCount": 1,
            "progress": 0,
            "duration": 10,
            "requiresWarp": false,
            "waypointStationIds": [],
            "distanceLy": 0,
            "warpersPerVessel": 0,
            "vehicleStationId": "route-demand",
            "mod:route/opaque": { "signedZero": -0.0, "text": "原样" }
        }]);
        let state = fixture_state(&entities);
        let base = fixture_base().as_object().unwrap().clone();
        let powers = HashMap::from([(0, 1.0), (1, 1.0)]);
        let mut transition_runtime = state
            .prepared_station_mode_transition_runtime()
            .expect("transition runtime");
        let mut local_directory = std::sync::Arc::new(
            crate::local_logistics::prepare_step_directory(
                &entities,
                &state.factory_topology.station_indices,
            )
            .unwrap(),
        );
        let mut route_activity = std::sync::Arc::new(
            crate::interstellar_logistics::prepare_route_activity(&entities),
        );
        let mut peer_directory = std::sync::Arc::new(
            crate::interstellar_logistics::InterstellarPeerDirectory::build(
                &state, &base, &entities,
            ),
        );
        let mut quantum_directory =
            crate::quantum_logistics::QuantumLogisticsDirectory::build(&state, &entities);
        assert!(local_directory.contains_local_station(0));
        assert!(
            !quantum_directory
                .endpoint_indices(&state, &entities)
                .unwrap()
                .contains(&0)
        );

        crate::interstellar_logistics::advance_routes(
            &state,
            &mut entities,
            5.0,
            &powers,
            std::sync::Arc::make_mut(&mut route_activity),
        )
        .unwrap();
        let first_post_route_ledger = crate::station_route_ledger::StationRouteLedger::build(
            &state,
            &entities,
            &local_directory,
            &route_activity,
        );
        assert!(first_post_route_ledger.references_station(0));
        let (changed, first_scan) = settle_post_route_station_mode_transition(
            &state,
            &mut transition_runtime,
            &mut entities,
            &first_post_route_ledger,
        )
        .unwrap();
        assert!(!changed);
        assert_eq!(first_scan.selected_rows, 1);
        assert_eq!(
            transition_runtime.as_ref().active_row_count(),
            1,
            "blocked row must remain awake"
        );

        crate::interstellar_logistics::advance_routes(
            &state,
            &mut entities,
            5.0,
            &powers,
            std::sync::Arc::make_mut(&mut route_activity),
        )
        .unwrap();
        let second_post_route_ledger = crate::station_route_ledger::StationRouteLedger::build(
            &state,
            &entities,
            &local_directory,
            &route_activity,
        );
        assert!(!second_post_route_ledger.references_station(0));
        let (changed, second_scan) = settle_post_route_station_mode_transition(
            &state,
            &mut transition_runtime,
            &mut entities,
            &second_post_route_ledger,
        )
        .unwrap();
        assert!(changed);
        assert_eq!(second_scan.selected_rows, 1);
        assert_eq!(transition_runtime.as_ref().active_row_count(), 0);
        assert_eq!(entities[0]["stationOperationMode"], "elevator");
        assert!(entities[0]["stationModeTransition"].is_null());

        let old_local = local_directory.clone();
        let old_peer = peer_directory.clone();
        let old_activity = route_activity.clone();
        refresh_station_mode_dependent_directories(
            &state,
            &base,
            &entities,
            true,
            &mut local_directory,
            &mut quantum_directory,
            &mut peer_directory,
            &mut route_activity,
        )
        .unwrap();
        assert!(!std::sync::Arc::ptr_eq(&old_local, &local_directory));
        assert!(!std::sync::Arc::ptr_eq(&old_peer, &peer_directory));
        assert!(!std::sync::Arc::ptr_eq(&old_activity, &route_activity));
        assert!(!local_directory.contains_local_station(0));
        assert!(
            quantum_directory
                .endpoint_indices(&state, &entities)
                .unwrap()
                .is_empty()
        );
    }
}
