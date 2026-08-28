use std::collections::{HashMap, HashSet};

use anyhow::{Context, anyhow, bail};
use serde_json::{Map, Number, Value, json};

use crate::catalog::{BuildingDefinition, RecipeDefinition};
use crate::deterministic_runtime::{
    DeterministicRuntime, PARALLEL_MIN_ITEMS, runtime as deterministic_runtime,
};
use crate::state::CoreState;

const EPSILON: f64 = 0.0001;
const MIN_BUILDING_BUFFER_LIMIT: f64 = 1_000.0;
const DEFAULT_BUILDING_BUFFER_LIMIT: f64 = 1_000_000.0;
const MAX_BUILDING_BUFFER_LIMIT: f64 = 100_000_000.0;
const GRID_IDS: [&str; 3] = ["grid-a", "grid-b", "grid-c"];

fn collect_indexed_power_probes<T, R, F>(values: &[T], probe: F) -> Vec<R>
where
    T: Sync,
    R: Send,
    F: Fn(&T) -> R + Send + Sync,
{
    collect_indexed_power_probes_with_runtime(deterministic_runtime(), values, probe)
}

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

#[derive(Debug, Clone)]
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

#[derive(Debug, Clone, Copy)]
enum PowerSourceKind {
    Ray,
    Fuel,
    Accumulator,
    Exchanger,
    Wind,
    Solar,
    Geothermal,
}

#[derive(Debug)]
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

#[derive(Debug)]
struct PowerDemandProbe {
    entity_index: usize,
    planet_index: usize,
    grid_index: usize,
    demand_kw: f64,
    priority: usize,
    demand_active: bool,
    zero_if_disconnected: bool,
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

fn apply_power_source_probe(probe: PowerSourceProbe, grids: &mut [GridRuntime]) {
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
    if let Some(candidate) = probe.dispatch_candidate {
        runtime.dispatch_candidates.push(candidate);
    }
    if let Some(candidate) = probe.accumulator_charge_candidate {
        runtime.accumulator_charge_candidates.push(candidate);
    }
    if let Some(candidate) = probe.exchanger_charge_candidate {
        runtime.exchanger_charge_candidates.push(candidate);
    }
    if let Some(output) = probe.power_output_kw {
        runtime
            .power_output_by_entity
            .insert(probe.entity_index, output);
    }
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

fn reset_research_machine_progress(entities: &mut [Value]) -> anyhow::Result<()> {
    for entity in entities.iter_mut().filter_map(Value::as_object_mut) {
        if string_at(entity, "recipeId") == Some("matrix_research") {
            set_number(entity, "progress", 0.0)?;
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
) -> MachineLocalSettlementPlan {
    plan_local_machine_settlement_with_threshold(state, runtime, PARALLEL_MIN_ITEMS)
}

fn plan_local_machine_settlement_with_threshold(
    state: &CoreState,
    runtime: &DeterministicRuntime,
    parallel_min_items: usize,
) -> MachineLocalSettlementPlan {
    debug_assert!(parallel_min_items > 0);
    let mut plan = MachineLocalSettlementPlan::default();
    let parallel_allowed = runtime.worker_limit() > 1
        && state.factory_topology.ordinary_machine_indices.len() >= parallel_min_items;
    let mut candidate_indices = Vec::new();

    for &entity_index in &state.factory_topology.ordinary_machine_indices {
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

fn transfer_logistics_buffers(
    state: &CoreState,
    base: &Map<String, Value>,
    entities: &mut [Value],
    entity_indices: &[usize],
) -> anyhow::Result<()> {
    let limit = normalized_buffer_limit(
        base.get("settings")
            .and_then(Value::as_object)
            .and_then(|settings| settings.get("logisticsBufferLimit")),
    );
    for &entity_index in entity_indices {
        let entity = entities[entity_index]
            .as_object_mut()
            .ok_or_else(|| anyhow!("native logistics buffer is invalid"))?;
        let Some(item_id) = string_at(entity, "storedItemId").map(str::to_owned) else {
            continue;
        };
        let building = string_at(entity, "buildingId")
            .and_then(|id| state.catalog.buildings.get(id))
            .ok_or_else(|| anyhow!("native logistics building is missing"))?;
        let capacity = stacked_capacity(
            building.output_capacity,
            finite_number(entity.get("machineCount")),
            limit,
        );
        let incoming = entity
            .get("inputs")
            .and_then(Value::as_object)
            .and_then(|inputs| inputs.get(&item_id))
            .map(|value| (finite_number(Some(value)) + EPSILON).floor())
            .unwrap_or(0.0);
        let stored = entity
            .get("outputs")
            .and_then(Value::as_object)
            .and_then(|outputs| outputs.get(&item_id))
            .map(|value| (finite_number(Some(value)) + EPSILON).floor())
            .unwrap_or(0.0);
        let moved = incoming.min((capacity - stored).max(0.0));
        entity
            .get_mut("inputs")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native logistics inputs are missing"))?
            .insert(
                item_id.clone(),
                Number::from_f64(incoming - moved)
                    .map(Value::Number)
                    .unwrap_or(Value::from(0)),
            );
        entity
            .get_mut("outputs")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native logistics outputs are missing"))?
            .insert(
                item_id,
                Number::from_f64(stored + moved)
                    .map(Value::Number)
                    .unwrap_or(Value::from(0)),
            );
    }
    Ok(())
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

fn drain_material_delivery_hubs(
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

// Keep each mutable runtime dependency explicit at the candidate boundary;
// bundling them would obscure which wake cache is committed only on success.
#[allow(clippy::too_many_arguments)]
fn simulate_step(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entities: &mut [Value],
    belt_runtime: &mut crate::belts::BeltRuntime,
    belt_routes: &crate::belts::PreparedRoutes,
    local_step_directory: &mut std::sync::Arc<crate::local_logistics::LocalPeerDirectory>,
    interstellar_route_activity: &mut std::sync::Arc<
        crate::interstellar_logistics::InterstellarRouteActivity,
    >,
    seconds: f64,
) -> anyhow::Result<()> {
    let profile_enabled = std::env::var_os("DSP_NATIVE_CORE_PROFILE").is_some();
    let mut profile_checkpoint = std::time::Instant::now();
    macro_rules! profile_mark {
        ($label:literal) => {
            if profile_enabled {
                eprintln!(
                    "DSP_NATIVE_CORE_PROFILE\t{}\t{:.3}",
                    $label,
                    profile_checkpoint.elapsed().as_secs_f64() * 1_000.0
                );
                profile_checkpoint = std::time::Instant::now();
            }
        };
    }
    if profile_enabled {
        eprintln!(
            "DSP_NATIVE_CORE_PROFILE\tfactory-power-probe-workers\t{}",
            deterministic_runtime().worker_limit()
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
    let indexed_quantum_endpoint_indices = state
        .factory_topology
        .quantum_endpoint_indices
        .iter()
        .copied()
        .filter(|&index| {
            entities[index]
                .as_object()
                .is_some_and(|entity| string_at(entity, "quantumMode") == Some("quantum"))
        })
        .collect::<Vec<_>>();
    profile_mark!("static-step-indexes");
    let time_warp_controller = prepare_time_warp(state, base, entities)?;
    crate::global_progress::advance_exploration(state, base, seconds)?;
    crate::global_progress::advance_handcraft(state, base, seconds)?;
    crate::dyson::advance_environment(base, seconds)?;
    profile_mark!("time-warp-and-dyson-environment");
    crate::local_logistics::reset_runtime_for_indices(
        entities,
        &state.factory_topology.station_indices,
    )?;
    profile_mark!("local-runtime-reset");
    profile_mark!("local-step-directory");
    transfer_logistics_buffers(
        state,
        base,
        entities,
        &state.factory_topology.logistics_buffer_indices,
    )?;
    profile_mark!("ordinary-logistics-buffers");
    // Only candidate-local wake vectors are mutable. Arc::make_mut preserves
    // the source revision's runtime cache if any later simulation stage fails.
    let local_step_runtime = std::sync::Arc::make_mut(local_step_directory);
    crate::local_logistics::transfer_buffers(state, base, entities, local_step_runtime)?;
    profile_mark!("local-logistics-buffers");
    crate::quantum_logistics::flush_supply_buffers(base, entities)?;
    profile_mark!("quantum-supply-buffers");
    profile_mark!("belt-route-index");
    let mut belt_changed_entity_indices = Vec::new();
    crate::belts::transfer(
        state,
        base,
        entities,
        belt_runtime,
        belt_routes,
        seconds,
        true,
        None,
        seconds,
        &mut belt_changed_entity_indices,
    )?;
    crate::local_logistics::wake_transfer_buffers_from_changed_entities(
        entities,
        &belt_changed_entity_indices,
        local_step_runtime,
    )?;
    profile_mark!("belt-input-transfer");
    let belt_reservation = crate::belts::reserve(state, base, entities, belt_runtime, belt_routes)?;
    profile_mark!("belt-reservation");
    crate::interstellar_logistics::run_orbital_collectors(
        state,
        base,
        entities,
        seconds,
        &belt_reservation.output_credits,
    )?;
    drain_material_delivery_hubs(
        state,
        base,
        entities,
        &state.factory_topology.material_delivery_hub_indices,
        seconds,
    )?;
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

    let power_source_probes = collect_indexed_power_probes(
        &state.factory_topology.power_source_indices,
        |&entity_index| {
            probe_power_source(
                state,
                entities,
                &reception,
                &profiles,
                production_buffer_limit,
                seconds,
                entity_index,
            )
        },
    );
    for probe in power_source_probes {
        if let Some(probe) = probe? {
            apply_power_source_probe(probe, &mut grids);
        }
    }
    profile_mark!("power-source-index");

    // Local and interstellar readiness consume the same immutable route
    // snapshot. The active queues preserve persisted row order; a dense set
    // falls back to the complete station ledger without changing dispatch
    // fairness or command authority.
    let mut step_route_ledger = crate::station_route_ledger::StationRouteLedger::build(
        state,
        entities,
        local_step_runtime,
        interstellar_route_activity.as_ref(),
    );
    if profile_enabled {
        let scan = step_route_ledger.scan();
        eprintln!(
            "DSP_NATIVE_CORE_PROFILE\tstation-route-ledger-ready\t{}/{}\tdense={}",
            scan.selected_demands, scan.total_candidate_rows, scan.dense_fallback
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
    if crate::construction::has_deficit(state, base) {
        ready_stations.extend(
            state
                .factory_topology
                .construction_center_indices
                .iter()
                .copied(),
        );
    }
    ready_stations.extend(crate::galactic_exports::ready_exporter_indices(
        state, entities,
    ));
    ready_stations.extend(crate::system_space_station::active_power_consumers(
        state, base, entities,
    ));
    let mut ready_station_indices = ready_stations.into_iter().collect::<Vec<_>>();
    ready_station_indices.sort_unstable();
    let mut disconnected_power_factor_indices = Vec::new();
    let ready_station_probes =
        collect_indexed_power_probes(&ready_station_indices, |&entity_index| {
            probe_ready_station_demand(state, entities, power_demand_multiplier, entity_index)
        });
    for probe in ready_station_probes {
        apply_power_demand_probe(probe?, &mut grids, &mut disconnected_power_factor_indices);
    }

    let vein_probes =
        collect_indexed_power_probes(&state.factory_topology.vein_indices, |&entity_index| {
            probe_vein_demand(
                state,
                entities,
                production_buffer_limit,
                power_demand_multiplier,
                entity_index,
            )
        });
    for probe in vein_probes {
        if let Some(probe) = probe? {
            apply_power_demand_probe(probe, &mut grids, &mut disconnected_power_factor_indices);
        }
    }
    profile_mark!("power-demand-index");

    let industrial_speed = industrial_speed_multiplier(base);
    let research_speed = research_speed_multiplier(base);
    let machine_probes = collect_indexed_power_probes(
        &state.factory_topology.ordinary_machine_indices,
        |&entity_index| {
            probe_machine_demand(
                state,
                base,
                entities,
                &profiles,
                production_buffer_limit,
                power_demand_multiplier,
                industrial_speed,
                research_speed,
                seconds,
                entity_index,
            )
        },
    );
    for probe in machine_probes {
        if let Some(probe) = probe? {
            apply_power_demand_probe(probe, &mut grids, &mut disconnected_power_factor_indices);
        }
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
        let dispatch_capacity = runtime
            .dispatch_candidates
            .iter()
            .map(|candidate| candidate.capacity)
            .sum::<f64>();
        runtime.generation_kw = runtime.base_generation_kw + dispatch_capacity;
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
        deterministic_runtime(),
        &state.factory_topology.vein_indices,
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
    let local_machine_settlement_plan =
        plan_local_machine_settlement(state, deterministic_runtime());
    if profile_enabled {
        eprintln!(
            "DSP_NATIVE_CORE_PROFILE\tfactory-local-machine-settlement\tworkers={}\tparallel={}\tfallback={}\tbarriers={}\tbatches={}",
            deterministic_runtime().worker_limit(),
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
    let mut produced_by_item = HashMap::<String, f64>::new();
    let has_galactic_material_exporter = state.factory_topology.has_galactic_material_exporter;
    let research_entity_indexes = &state.factory_topology.research_entity_indices;
    let mut reset_research_progress_before_next_entity = false;

    for &entity_index in &state.factory_topology.non_station_indices {
        if reset_research_progress_before_next_entity {
            reset_indexed_research_machine_progress(entities, research_entity_indexes)?;
            reset_research_progress_before_next_entity = false;
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
                crate::dyson::launch(state, base, object, &recipe.id, cycles)?;
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
    if local_machine_settlement_indices
        .as_mut()
        .is_some_and(|indices| indices.next().is_some())
    {
        bail!("native local machine settlement plan was not fully applied");
    }
    if let Some(events) = machine_production_events {
        let outcomes = execute_local_machine_settlement_tasks_with_runtime(
            deterministic_runtime(),
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
    profile_mark!("power-facilities-machines-miners");

    if reset_research_progress_before_next_entity {
        reset_indexed_research_machine_progress(entities, research_entity_indexes)?;
    }
    profile_mark!("research-reset");

    crate::construction::run_centers(
        state,
        base,
        entities,
        seconds,
        &power_factors,
        &state.factory_topology.construction_center_indices,
    )?;
    profile_mark!("construction");

    crate::dyson::run_ray_receivers(
        state,
        base,
        entities,
        seconds,
        &belt_reservation.output_credits,
        &reception,
    )?;
    profile_mark!("ray-receivers");

    crate::orbital_station::settle(state, base, entities, seconds)?;
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

    // Preserve the per-planet entity accumulation order while avoiding one
    // complete entity scan per planet for production and reserve metrics.
    let mut total_items_before_global = vec![0.0; planet_ids.len()];
    let mut power_reserves_by_planet = vec![(0.0, 0.0, 0.0, 0.0); planet_ids.len()];
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
            reserves.2 += fuel_energy_available(state, entity, building) * building.fuel_efficiency;
            reserves.3 += building.power_generation_kw * finite_number(entity.get("machineCount"));
        }
    }

    let quantum_flow = if crossed_quantum_boundary {
        crate::quantum_logistics::settle_downloads(
            state,
            base,
            entities,
            &belt_reservation.output_credits,
            first_quantum_boundary as f64 * 5.0,
            5.0,
        )?
    } else {
        None
    };
    profile_mark!("quantum-download");

    crate::belts::transfer(
        state,
        base,
        entities,
        belt_runtime,
        belt_routes,
        0.0,
        false,
        Some(&belt_reservation),
        seconds,
        &mut belt_changed_entity_indices,
    )?;
    crate::local_logistics::wake_transfer_buffers_from_changed_entities(
        entities,
        &belt_changed_entity_indices,
        local_step_runtime,
    )?;
    drain_material_delivery_hubs(
        state,
        base,
        entities,
        &state.factory_topology.material_delivery_hub_indices,
        seconds,
    )?;
    profile_mark!("belt-output-transfer");

    let station_powers = state
        .factory_topology
        .station_indices
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
    crate::interstellar_logistics::refill_station_warpers(base, entities)?;
    if profile_enabled {
        let scan = step_route_ledger.scan();
        eprintln!(
            "DSP_NATIVE_CORE_PROFILE\tstation-route-ledger-dispatch-reuse\t{}/{}\tdense={}",
            scan.selected_demands, scan.total_candidate_rows, scan.dense_fallback
        );
    }
    crate::local_logistics::dispatch(
        state,
        base,
        entities,
        &station_powers,
        local_step_runtime,
        &mut step_route_ledger,
    )?;
    profile_mark!("local-dispatch");
    let interstellar_step_runtime = std::sync::Arc::make_mut(interstellar_route_activity);
    crate::interstellar_logistics::dispatch(
        state,
        base,
        entities,
        &station_powers,
        interstellar_step_runtime,
        &mut step_route_ledger,
    )?;
    drop(step_route_ledger);
    profile_mark!("interstellar-dispatch");
    crate::local_logistics::advance_routes(
        state,
        base,
        entities,
        seconds,
        &station_powers,
        local_step_runtime,
    )?;
    profile_mark!("local-route-advance");
    crate::interstellar_logistics::advance_routes(
        state,
        entities,
        seconds,
        &station_powers,
        interstellar_step_runtime,
    )?;
    profile_mark!("interstellar-route-advance");
    crate::interstellar_logistics::refill_station_warpers(base, entities)?;
    // Route completion can remove the final active demand, so congestion must
    // use a fresh post-advance snapshot rather than the readiness ledger.
    let congestion_route_ledger = crate::station_route_ledger::StationRouteLedger::build(
        state,
        entities,
        local_step_runtime,
        interstellar_step_runtime,
    );
    if profile_enabled {
        let scan = congestion_route_ledger.scan();
        eprintln!(
            "DSP_NATIVE_CORE_PROFILE\tstation-route-ledger-congestion\t{}/{}\tdense={}",
            scan.selected_demands, scan.total_candidate_rows, scan.dense_fallback
        );
    }
    crate::local_logistics::update_congestion(
        state,
        entities,
        local_step_runtime,
        &congestion_route_ledger,
    )?;
    profile_mark!("local-congestion");
    crate::interstellar_logistics::update_congestion(
        state,
        base,
        entities,
        &congestion_route_ledger,
    )?;
    drop(congestion_route_ledger);
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
            station_mode_topology_changed |=
                crate::system_space_station::settle_mode_transitions(entities)?;
            crate::quantum_logistics::settle_transitions(base, entities)?;
            crate::system_space_station::settle_construction(state, base, entities)?;
            crate::system_space_station::settle_hubs(
                state,
                base,
                entities,
                boundary as f64 * crate::system_space_station::boundary_seconds(),
            )?;
            crate::quantum_logistics::settle_uploads(
                base,
                entities,
                boundary as f64 * 5.0,
                quantum_flow.clone(),
                5.0,
                &indexed_quantum_endpoint_indices,
            )?;
        }
        // Elevator-mode transitions are the only boundary event that changes
        // local peer membership. Stable five-second settlements retain the
        // cross-revision wake cache; an actual transition rebuilds once.
        crate::local_logistics::refresh_step_directory_after_topology_change(
            entities,
            &state.factory_topology.station_indices,
            station_mode_topology_changed,
            local_step_directory,
        )?;
        crate::interstellar_logistics::refresh_route_activity_after_topology_change(
            entities,
            station_mode_topology_changed,
            interstellar_route_activity,
        );
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
    let _ = profile_checkpoint.elapsed();
    Ok(())
}

pub(crate) struct PreparedFactoryAdvance {
    pub base: Map<String, Value>,
    pub entities: Vec<Value>,
    pub belt_commit: crate::belts::BeltCommitBatch,
    pub belt_flow: crate::belts::PreparedBeltFlow,
    pub belt_scheduler: crate::belts::BeltSchedulerDiagnostics,
    pub belt_routes: std::sync::Arc<crate::belts::PreparedRoutes>,
    pub belt_activity: std::sync::Arc<crate::belts::BeltActivitySnapshot>,
    pub local_peer_directory: std::sync::Arc<crate::local_logistics::LocalPeerDirectory>,
    pub interstellar_route_activity:
        std::sync::Arc<crate::interstellar_logistics::InterstellarRouteActivity>,
}

pub(crate) fn prepare_advance(
    state: &CoreState,
    simulation_seconds: f64,
    wall_seconds: f64,
) -> anyhow::Result<PreparedFactoryAdvance> {
    let profile_enabled = std::env::var_os("DSP_NATIVE_CORE_PROFILE").is_some();
    let mut profile_checkpoint = std::time::Instant::now();
    if profile_enabled {
        let runtime = crate::deterministic_runtime::runtime();
        eprintln!(
            "DSP_NATIVE_CORE_PROFILE\truntime-worker-limit\t{}",
            runtime.worker_limit()
        );
        eprintln!(
            "DSP_NATIVE_CORE_PROFILE\truntime-observed-workers\t{}",
            runtime.observed_worker_count()
        );
    }
    macro_rules! profile_mark {
        ($label:literal) => {
            if profile_enabled {
                eprintln!(
                    "DSP_NATIVE_CORE_PROFILE\tstate-{}\t{:.3}",
                    $label,
                    profile_checkpoint.elapsed().as_secs_f64() * 1_000.0
                );
                profile_checkpoint = std::time::Instant::now();
            }
        };
    }
    let mut entities = state.take_entities_for_simulation()?;
    // JS copyState() materializes both sparse runtime maps before either a
    // simulation step or a wall-clock-only speedrun advance. Mirror that
    // shape here so a zero-simulation budget remains canonically exact.
    for entity in entities.iter_mut().filter_map(Value::as_object_mut) {
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
    }
    profile_mark!("parse-records");
    let belt_routes = if let Some(routes) = state.prepared_belt_routes() {
        routes
    } else {
        std::sync::Arc::new(crate::belts::prepare_routes_from_state(state, &entities)?)
    };
    let mut local_peer_directory = if let Some(directory) = state.prepared_local_peer_directory() {
        directory
    } else {
        std::sync::Arc::new(crate::local_logistics::prepare_step_directory(
            &entities,
            &state.factory_topology.station_indices,
        )?)
    };
    let mut interstellar_route_activity =
        if let Some(activity) = state.prepared_interstellar_route_activity() {
            activity
        } else {
            std::sync::Arc::new(crate::interstellar_logistics::prepare_route_activity(
                &entities,
            ))
        };
    let mut belt_runtime = crate::belts::BeltRuntime::from_state(
        state,
        &entities,
        &belt_routes,
        state.prepared_belt_activity(),
    )?;
    let mut base = state.base_value().clone();
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
    while remaining > EPSILON {
        let mut step = remaining.min(step_size);
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
        simulate_step(
            state,
            &mut base,
            &mut entities,
            &mut belt_runtime,
            &belt_routes,
            &mut local_peer_directory,
            &mut interstellar_route_activity,
            step,
        )
        .context("advance native simple factory step")?;
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
        remaining = (remaining - step).max(0.0);
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
    profile_mark!("simulate-steps");
    let belt_activity = belt_runtime.activity_snapshot(&belt_routes);
    let belt_flow_requirement = crate::production_history::belt_flow_requirement(&base)?;
    let (belt_commit, belt_flow, belt_scheduler) =
        belt_runtime.into_patches(state, belt_flow_requirement)?;
    profile_mark!("belt-runtime-write-back");
    settle_completed_research_boundaries(state, &mut base, &mut entities)?;
    profile_mark!("research-boundaries-after");
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
    let _ = profile_checkpoint.elapsed();
    Ok(PreparedFactoryAdvance {
        base,
        entities,
        belt_commit,
        belt_flow,
        belt_scheduler,
        belt_routes,
        belt_activity,
        local_peer_directory,
        interstellar_route_activity,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::{
        BeltDefinition, CatalogSnapshot, ItemAmount, ItemDefinition, PlanetDefinition,
        ProliferatorDefinition, RecipeDefinition, RuntimeCatalog,
    };
    use crate::state::CoreCheckpointIdentity;
    use serde_json::json;
    use std::collections::BTreeMap;
    use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};

    fn fixture_checksum(bytes: &[u8]) -> String {
        let mut hash = 0x811c9dc5_u32;
        for byte in bytes {
            hash ^= u32::from(*byte);
            hash = hash.wrapping_mul(0x01000193);
        }
        format!("{hash:08x}")
    }

    fn fixture_building(id: &str) -> BuildingDefinition {
        BuildingDefinition {
            id: id.to_owned(),
            kind: "machine".to_owned(),
            speed: 1.0,
            input_capacity: 100.0,
            output_capacity: 100.0,
            power_demand_kw: 1.0,
            power_generation_kw: 0.0,
            power_charge_kw: 0.0,
            energy_capacity_mj: 0.0,
            fuel_item_ids: Vec::new(),
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

    fn fixture_catalog() -> RuntimeCatalog {
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
                registry_fingerprint: "machine-e3".to_owned(),
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
                    fuel_energy_mj: 0.0,
                })
                .collect(),
                buildings: [
                    "arc_smelter",
                    "matrix_lab",
                    "em_rail_ejector",
                    "vertical_launching_silo",
                    "mining_machine",
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
                constructions: Vec::new(),
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
                technologies: Vec::new(),
            },
            "machine-e3",
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
                registry_fingerprint: "machine-e3".to_owned(),
                base_primary_checksum: "12345678".to_owned(),
            },
            &records,
            fixture_catalog(),
        )
        .unwrap()
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

        let production_threshold =
            plan_local_machine_settlement(&state, &DeterministicRuntime::for_test(8));
        assert!(production_threshold.batches.is_empty());
        assert_eq!(production_threshold.serial_fallback_count, 9);
        assert_eq!(production_threshold.global_barrier_count, 3);

        let one_worker = plan_local_machine_settlement_with_threshold(
            &state,
            &DeterministicRuntime::for_test(1),
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
        let plan = plan_local_machine_settlement(&state, &DeterministicRuntime::for_test(8));
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
}
