use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::sync::Arc;

use anyhow::{anyhow, bail};
use num_bigint::BigUint;
use num_traits::Zero;
use serde_json::{Map, Number, Value};

use crate::catalog::{ItemAmount, RuntimeCatalog};
use crate::deterministic_runtime::{DeterministicRuntime, runtime as deterministic_runtime};
use crate::state::CoreState;

const EPSILON: f64 = 0.0001;
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
const CONSTRUCTION_RECEIPT_HISTORY_LIMIT: usize = 64;
const CONSTRUCTION_MAX_ITERATIONS_PER_SECOND: f64 = 256.0;
const CONSTRUCTION_MAX_PLAN_BUILDS_PER_SECOND: f64 = 24.0;
const CONSTRUCTION_EXTENDED_STACK_THRESHOLD: f64 = 1_000_000.0;
const CONSTRUCTION_EXTENDED_MAX_ITERATIONS_PER_SECOND: f64 = 512.0;
const CONSTRUCTION_EXTENDED_MAX_PLAN_BUILDS_PER_SECOND: f64 = 512.0;
const CONSTRUCTION_MAX_FAIR_BATCH_JOBS: f64 = 4_096.0;
const CONSTRUCTION_EXTENDED_MAX_FAIR_BATCH_JOBS: f64 = 1_000_000.0;
const CONSTRUCTION_QUANTUM_PREFETCH_SECONDS: f64 = 5.0;
const CONSTRUCTION_QUANTUM_PREFETCH_MAX_JOBS: f64 = 10_000_000.0;
const CONSTRUCTION_QUANTUM_EXTENDED_PREFETCH_MAX_JOBS: f64 = 100_000_000.0;

#[derive(Debug, Clone)]
enum Step {
    Material {
        recipe_id: String,
        batches: f64,
        output_item_id: String,
        output_amount: f64,
    },
    Building {
        construction_id: String,
    },
    Fleet {
        item_id: String,
        amount: f64,
    },
}

#[derive(Debug, Clone)]
pub(crate) struct QuantumDemand {
    pub key: String,
    pub entity_index: usize,
    pub active_row: Option<usize>,
    pub entity_id: String,
    pub item_id: String,
    pub amount: u64,
}

/// Runtime-only reverse-wake evidence for the quantum construction demand
/// directory. These rows are entity indexes from the immutable factory
/// topology; they are never persisted or included in a public save hash.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct ConstructionQuantumWake {
    pub center_indices: Vec<usize>,
}

const CONSTRUCTION_ACTIVE_DENSE_NUMERATOR: usize = 3;
const CONSTRUCTION_ACTIVE_DENSE_DENOMINATOR: usize = 4;
const POWER_GROUPS_PER_PLANET: usize = 9;
const CONSTRUCTION_POWER_MULTIPLIERS: [f64; 3] = [0.9, 1.0, 1.2];

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct ConstructionActiveScan {
    pub selected_rows: usize,
    pub total_rows: usize,
    pub dense_fallback: bool,
    pub directory_fallback: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct ConstructionRunOutcome {
    pub quantum_wake: ConstructionQuantumWake,
    pub scan: ConstructionActiveScan,
    pub receipt: ConstructionRunReceipt,
}

/// Private evidence emitted by the construction stage itself. It is held only
/// in the prepared runtime and is never serialized, hashed, or exposed through
/// the native Host protocol. `BTreeMap` keeps the fold independent from HashMap
/// iteration order while the exact stage remains free to use its existing data
/// structures.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct ConstructionRunReceipt {
    pub outputs: BTreeMap<String, i128>,
    pub crafted: i128,
    proof_invalid: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct VersionedConstructionRunReceipt {
    base_revision: u64,
    receipt: ConstructionRunReceipt,
}

impl ConstructionRunReceipt {
    fn record_completion(&mut self, output_id: Option<&str>, amount: f64) {
        if !nonnegative_safe_integer(amount) || amount < 1.0 {
            self.proof_invalid = true;
            return;
        }
        let amount = amount as i128;
        let Some(crafted) = self.crafted.checked_add(amount) else {
            self.proof_invalid = true;
            return;
        };
        let next_output = output_id.and_then(|item_id| {
            self.outputs
                .get(item_id)
                .copied()
                .unwrap_or(0)
                .checked_add(amount)
                .map(|total| (item_id.to_owned(), total))
        });
        if output_id.is_some() && next_output.is_none() {
            self.proof_invalid = true;
            return;
        }
        self.crafted = crafted;
        if let Some((item_id, total)) = next_output {
            self.outputs.insert(item_id, total);
        }
    }

    fn merge(&mut self, other: &Self) {
        if self.proof_invalid || other.proof_invalid {
            self.proof_invalid = true;
            return;
        }
        let Some(crafted) = self.crafted.checked_add(other.crafted) else {
            self.proof_invalid = true;
            return;
        };
        let mut outputs = self.outputs.clone();
        for (item_id, amount) in &other.outputs {
            let Some(total) = outputs
                .get(item_id)
                .copied()
                .unwrap_or(0)
                .checked_add(*amount)
            else {
                self.proof_invalid = true;
                return;
            };
            outputs.insert(item_id.clone(), total);
        }
        self.crafted = crafted;
        self.outputs = outputs;
    }

    fn proof_eligible(&self) -> bool {
        !self.proof_invalid
    }

    #[cfg(test)]
    pub(crate) fn for_test(outputs: BTreeMap<String, i128>, crafted: i128) -> Self {
        Self {
            outputs,
            crafted,
            proof_invalid: false,
        }
    }
}

/// One exact aggregate of construction-center demand for a single
/// planet/grid/priority bucket. The public power ledger can register this row
/// instead of every dormant center only after proving that all demand folds
/// remain safe-integer exact.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct ConstructionPowerGroupDemand {
    pub representative_entity_index: usize,
    pub planet_index: usize,
    pub grid_index: usize,
    pub priority: usize,
    pub demand_kw: f64,
    pub center_count: usize,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct ConstructionPowerDemandPlan {
    pub has_deficit: bool,
    pub aggregate_candidate: bool,
    pub directory_fallback: bool,
    pub groups: Vec<ConstructionPowerGroupDemand>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PowerFactorSignature {
    Missing,
    Value(u64),
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ConstructionDependencySignature {
    enabled: bool,
    mode_normal: bool,
    orbital_station_locked: bool,
    completed_tech_ids: Vec<String>,
    target_limits: Vec<u64>,
    active_targets: Vec<bool>,
    has_work: bool,
    cursor: usize,
}

impl ConstructionDependencySignature {
    fn broad_dependencies_changed(&self, other: &Self) -> bool {
        self.enabled != other.enabled
            || self.mode_normal != other.mode_normal
            || self.orbital_station_locked != other.orbital_station_locked
            || self.completed_tech_ids != other.completed_tech_ids
            || self.target_limits != other.target_limits
            || self.active_targets != other.active_targets
            || self.has_work != other.has_work
    }
}

/// Runtime-only deterministic execution directory for construction centers.
///
/// Rows preserve the immutable entity order used by the historical full
/// scan. Sleeping rows are revisited only when a dependency can make their
/// result observably different: a planet inventory increases, their shared
/// power allocation changes, direct quantum material arrives, or global
/// planning/job state changes. The directory is never serialized or hashed.
#[derive(Debug, Clone)]
pub(crate) struct ConstructionRuntime {
    topology: Arc<crate::state::FactoryTopology>,
    catalog: Arc<RuntimeCatalog>,
    entity_count: usize,
    center_indices: Vec<usize>,
    row_by_entity: Vec<(u32, u32)>,
    row_planets: Vec<usize>,
    row_power_groups: Vec<usize>,
    row_machine_count_bits: Vec<u64>,
    target_ids: Vec<String>,
    target_output_amounts: Vec<f64>,
    target_by_id: BTreeMap<String, usize>,
    row_job_targets: Vec<Option<usize>>,
    pending_by_target: Vec<f64>,
    job_count: usize,
    power_group_rows: Vec<Vec<usize>>,
    active_power_groups: Vec<usize>,
    power_group_center_counts: Vec<usize>,
    power_group_demands: [Vec<f64>; 3],
    power_variant_exact: [bool; 3],
    power_group_representatives: Vec<Option<usize>>,
    observed_power: Vec<Option<PowerFactorSignature>>,
    planet_wait_rows: Vec<BTreeSet<usize>>,
    planner_wait_rows: BTreeSet<usize>,
    observed_planet_inventory: Vec<Option<Vec<(String, u64)>>>,
    observed_dependency: Option<ConstructionDependencySignature>,
    pending: BTreeSet<usize>,
    all_pending: bool,
    fallback_full_scan: bool,
    aggregated_power_factors: bool,
    provably_unpowered: Option<bool>,
    /// At most one entry per exact CoreState revision. Multiple simulation
    /// steps within the same advance merge into the same row. This private
    /// history lets pure-idle prove a bounded exact prefix that was split over
    /// several calls without adding anything to GameState v47.
    receipt_history: VecDeque<VersionedConstructionRunReceipt>,
}

impl ConstructionRuntime {
    fn record_run_receipt(&mut self, base_revision: u64, receipt: &ConstructionRunReceipt) {
        if self
            .receipt_history
            .back()
            .is_some_and(|entry| entry.base_revision == base_revision)
        {
            self.receipt_history
                .back_mut()
                .expect("checked construction receipt history tail")
                .receipt
                .merge(receipt);
            return;
        }

        let contiguous = self
            .receipt_history
            .back()
            .is_none_or(|entry| entry.base_revision.checked_add(1) == Some(base_revision));
        if !contiguous {
            self.receipt_history.clear();
        }
        self.receipt_history
            .push_back(VersionedConstructionRunReceipt {
                base_revision,
                receipt: receipt.clone(),
            });
        while self.receipt_history.len() > CONSTRUCTION_RECEIPT_HISTORY_LIMIT {
            self.receipt_history.pop_front();
        }
    }

    /// Merge only a contiguous series of exact-stage receipts. Missing,
    /// reordered, overflowed, or MOD-fractional rows fail closed and cannot be
    /// used as construction authority by pure-idle settlement.
    pub(crate) fn receipt_between(
        &self,
        base_revision: u64,
        result_revision: u64,
    ) -> Option<ConstructionRunReceipt> {
        if base_revision == result_revision {
            return Some(ConstructionRunReceipt::default());
        }
        if base_revision > result_revision {
            return None;
        }
        let mut expected_revision = base_revision;
        let mut merged = ConstructionRunReceipt::default();
        for entry in self
            .receipt_history
            .iter()
            .filter(|entry| entry.base_revision >= base_revision)
        {
            if entry.base_revision != expected_revision || !entry.receipt.proof_eligible() {
                return None;
            }
            merged.merge(&entry.receipt);
            if !merged.proof_eligible() {
                return None;
            }
            expected_revision = expected_revision.checked_add(1)?;
            if expected_revision == result_revision {
                return Some(merged);
            }
        }
        None
    }

    pub(crate) fn build(state: &CoreState, base: &Map<String, Value>, entities: &[Value]) -> Self {
        let planet_count = state.catalog.planets.len();
        let targets = crate::construction_planner::targets(state);
        let target_ids = targets
            .iter()
            .map(|target| target.id.clone())
            .collect::<Vec<_>>();
        let target_output_amounts = targets
            .iter()
            .map(|target| target.output_amount)
            .collect::<Vec<_>>();
        let target_by_id = target_ids
            .iter()
            .enumerate()
            .map(|(index, target_id)| (target_id.clone(), index))
            .collect::<BTreeMap<_, _>>();
        let power_group_count = planet_count
            .checked_mul(POWER_GROUPS_PER_PLANET)
            .unwrap_or_default();
        let mut runtime = Self {
            topology: state.factory_topology.clone(),
            catalog: state.catalog.clone(),
            entity_count: entities.len(),
            center_indices: state.factory_topology.construction_center_indices.clone(),
            row_by_entity: Vec::new(),
            row_planets: Vec::new(),
            row_power_groups: Vec::new(),
            row_machine_count_bits: Vec::new(),
            target_ids,
            target_output_amounts,
            target_by_id,
            row_job_targets: vec![None; state.factory_topology.construction_center_indices.len()],
            pending_by_target: vec![0.0; targets.len()],
            job_count: 0,
            power_group_rows: vec![Vec::new(); power_group_count],
            active_power_groups: Vec::new(),
            power_group_center_counts: vec![0; power_group_count],
            power_group_demands: std::array::from_fn(|_| vec![0.0; power_group_count]),
            power_variant_exact: [true; 3],
            power_group_representatives: vec![None; power_group_count],
            observed_power: vec![None; power_group_count],
            planet_wait_rows: vec![BTreeSet::new(); planet_count],
            planner_wait_rows: BTreeSet::new(),
            observed_planet_inventory: vec![None; planet_count],
            observed_dependency: None,
            pending: BTreeSet::new(),
            all_pending: true,
            fallback_full_scan: power_group_count == 0
                && !state
                    .factory_topology
                    .construction_center_indices
                    .is_empty(),
            aggregated_power_factors: false,
            provably_unpowered: None,
            receipt_history: VecDeque::new(),
        };
        let construction_power_demand_kw = state
            .catalog
            .buildings
            .get("construction_center")
            .map(|building| building.power_demand_kw);
        if construction_power_demand_kw.is_none() {
            runtime.fallback_full_scan = true;
            runtime.power_variant_exact = [false; 3];
        }
        let mut entity_ids = BTreeSet::new();
        let mut entity_rows = BTreeSet::new();
        for (row, &entity_index) in runtime.center_indices.iter().enumerate() {
            let Some(entity) = entities.get(entity_index).and_then(Value::as_object) else {
                runtime.fallback_full_scan = true;
                continue;
            };
            let Some(entity_id) = string_at(entity, "id").filter(|id| !id.is_empty()) else {
                runtime.fallback_full_scan = true;
                continue;
            };
            let Some((&planet_index, &grid_index)) = state
                .factory_topology
                .entity_planet_indices
                .get(entity_index)
                .zip(state.factory_topology.entity_grid_indices.get(entity_index))
            else {
                runtime.fallback_full_scan = true;
                continue;
            };
            if entity_index >= state.entities.ids.len() {
                runtime.fallback_full_scan = true;
                continue;
            }
            let indexed_id = &state.entities.ids[entity_index];
            let Some(indexed_building) = state.entities.buildings.get(entity_index) else {
                runtime.fallback_full_scan = true;
                continue;
            };
            let priority = finite_number(entity.get("powerPriority"))
                .floor()
                .clamp(1.0, 3.0) as usize;
            let machine_count = finite_number(entity.get("machineCount"));
            let canonical = string_at(entity, "buildingId") == Some("construction_center")
                && state.symbols.resolve(*indexed_building) == Some("construction_center")
                && entity_id == indexed_id
                && entity_id.is_ascii()
                && !entity_id.contains(':')
                && planet_index < planet_count
                && grid_index < 3
                && state
                    .catalog
                    .planets
                    .get(planet_index)
                    .is_some_and(|planet| {
                        string_at(entity, "planetId") == Some(planet.id.as_str())
                    })
                && entity_rows.insert(entity_index)
                && entity_ids.insert(entity_id.to_owned());
            if !canonical {
                runtime.fallback_full_scan = true;
                continue;
            }
            let Ok(entity_row) = u32::try_from(entity_index) else {
                runtime.fallback_full_scan = true;
                continue;
            };
            let Ok(runtime_row) = u32::try_from(row) else {
                runtime.fallback_full_scan = true;
                continue;
            };
            let group = planet_index * POWER_GROUPS_PER_PLANET + grid_index * 3 + priority - 1;
            runtime.row_by_entity.push((entity_row, runtime_row));
            runtime.row_planets.push(planet_index);
            runtime.row_power_groups.push(group);
            runtime.row_machine_count_bits.push(machine_count.to_bits());
            runtime.power_group_rows[group].push(row);
            if runtime.power_group_center_counts[group] == 0 {
                runtime.active_power_groups.push(group);
            }
            runtime.power_group_center_counts[group] += 1;
            if let Some(power_demand_kw) = construction_power_demand_kw {
                for (variant, multiplier) in CONSTRUCTION_POWER_MULTIPLIERS.iter().enumerate() {
                    let demand = power_demand_kw * machine_count * multiplier;
                    let next = runtime.power_group_demands[variant][group] + demand;
                    if !nonnegative_safe_integer(demand) || !nonnegative_safe_integer(next) {
                        runtime.power_variant_exact[variant] = false;
                    }
                    runtime.power_group_demands[variant][group] = next;
                }
            }
            runtime.power_group_representatives[group].get_or_insert(entity_index);
        }
        if runtime.row_by_entity.len() != runtime.center_indices.len()
            || runtime.row_planets.len() != runtime.center_indices.len()
            || runtime.row_power_groups.len() != runtime.center_indices.len()
            || runtime.row_machine_count_bits.len() != runtime.center_indices.len()
        {
            runtime.fallback_full_scan = true;
        }
        if runtime.center_indices.is_empty() {
            runtime.provably_unpowered = Some(false);
        } else {
            let mut power_topology_valid = true;
            let has_possible_source =
                state
                    .factory_topology
                    .power_source_indices
                    .iter()
                    .any(|&entity_index| {
                        let Some((&planet_index, &grid_index)) = state
                            .factory_topology
                            .entity_planet_indices
                            .get(entity_index)
                            .zip(state.factory_topology.entity_grid_indices.get(entity_index))
                        else {
                            power_topology_valid = false;
                            return false;
                        };
                        if planet_index >= planet_count || grid_index >= 3 {
                            power_topology_valid = false;
                            return false;
                        }
                        let first_group = planet_index * POWER_GROUPS_PER_PLANET + grid_index * 3;
                        runtime.power_group_center_counts[first_group..first_group + 3]
                            .iter()
                            .any(|&count| count > 0)
                    });
            if power_topology_valid {
                runtime.provably_unpowered = Some(!has_possible_source);
            }
        }
        runtime
            .row_by_entity
            .sort_unstable_by_key(|&(entity_index, _)| entity_index);
        if runtime
            .target_ids
            .iter()
            .any(|target_id| !target_id.is_ascii() || target_id.contains(':'))
            || automation(base)
                .ok()
                .and_then(|automation| automation.get("targetStock"))
                .and_then(Value::as_object)
                .is_some_and(|stock| {
                    stock
                        .keys()
                        .any(|target_id| !runtime.target_by_id.contains_key(target_id))
                })
        {
            runtime.fallback_full_scan = true;
        }
        let jobs = automation(base)
            .ok()
            .and_then(|automation| automation.get("jobs"))
            .and_then(Value::as_object);
        let Some(jobs) = jobs else {
            runtime.fallback_full_scan = true;
            return runtime;
        };
        for (entity_id, job) in jobs {
            let Some(entity_index) = state.entity_index.get(entity_id) else {
                runtime.fallback_full_scan = true;
                continue;
            };
            let Some(row) = runtime.row_for_entity(*entity_index) else {
                runtime.fallback_full_scan = true;
                continue;
            };
            let Some(target_id) = job
                .as_object()
                .and_then(|job| string_at(job, "constructionId"))
            else {
                runtime.fallback_full_scan = true;
                continue;
            };
            let Some(&target_index) = runtime.target_by_id.get(target_id) else {
                runtime.fallback_full_scan = true;
                continue;
            };
            runtime.row_job_targets[row] = Some(target_index);
            runtime.pending_by_target[target_index] += runtime.target_output_amounts[target_index];
            runtime.job_count += 1;
        }
        runtime.observed_dependency = runtime.dependency_signature(state, base).ok();
        if runtime.observed_dependency.is_none() {
            runtime.fallback_full_scan = true;
        }
        runtime.center_indices.shrink_to_fit();
        runtime.row_by_entity.shrink_to_fit();
        runtime.row_planets.shrink_to_fit();
        runtime.row_power_groups.shrink_to_fit();
        runtime.row_machine_count_bits.shrink_to_fit();
        runtime.target_ids.shrink_to_fit();
        runtime.target_output_amounts.shrink_to_fit();
        runtime.row_job_targets.shrink_to_fit();
        runtime.pending_by_target.shrink_to_fit();
        for rows in &mut runtime.power_group_rows {
            rows.shrink_to_fit();
        }
        runtime.power_group_rows.shrink_to_fit();
        runtime.active_power_groups.shrink_to_fit();
        runtime.power_group_center_counts.shrink_to_fit();
        for demands in &mut runtime.power_group_demands {
            demands.shrink_to_fit();
        }
        runtime.power_group_representatives.shrink_to_fit();
        runtime.observed_power.shrink_to_fit();
        runtime.planet_wait_rows.shrink_to_fit();
        runtime.observed_planet_inventory.shrink_to_fit();
        runtime
    }

    fn topology_matches(
        &self,
        state: &CoreState,
        entities: &[Value],
        center_indices: &[usize],
    ) -> bool {
        Arc::ptr_eq(&self.topology, &state.factory_topology)
            && Arc::ptr_eq(&self.catalog, &state.catalog)
            && self.entity_count == entities.len()
            && self.center_indices.len() == center_indices.len()
            && (center_indices.is_empty()
                || std::ptr::eq(
                    center_indices.as_ptr(),
                    state.factory_topology.construction_center_indices.as_ptr(),
                ))
    }

    fn row_for_entity(&self, entity_index: usize) -> Option<usize> {
        let entity_index = u32::try_from(entity_index).ok()?;
        self.row_by_entity
            .binary_search_by_key(&entity_index, |&(candidate, _)| candidate)
            .ok()
            .and_then(|index| self.row_by_entity.get(index))
            .map(|&(_, row)| row as usize)
    }

    fn power_factor_entity(&self, entity_index: usize) -> Option<usize> {
        if !self.aggregated_power_factors {
            return Some(entity_index);
        }
        let row = self.row_for_entity(entity_index)?;
        let group = *self.row_power_groups.get(row)?;
        self.power_group_representatives
            .get(group)
            .copied()
            .flatten()
    }

    fn dependency_signature(
        &self,
        state: &CoreState,
        base: &Map<String, Value>,
    ) -> anyhow::Result<ConstructionDependencySignature> {
        construction_dependency_signature(self, state, base)
    }

    fn update_job_target(&mut self, entity_index: usize, target_id: Option<&str>) {
        if self.fallback_full_scan {
            return;
        }
        let Some(row) = self.row_for_entity(entity_index) else {
            self.fallback_full_scan = true;
            return;
        };
        let next = match target_id {
            Some(target_id) => {
                let Some(&target_index) = self.target_by_id.get(target_id) else {
                    self.fallback_full_scan = true;
                    return;
                };
                Some(target_index)
            }
            None => None,
        };
        let previous = self.row_job_targets[row];
        if previous == next {
            return;
        }
        if let Some(target_index) = previous {
            self.pending_by_target[target_index] = (self.pending_by_target[target_index]
                - self.target_output_amounts[target_index])
                .max(0.0);
            self.job_count = self.job_count.saturating_sub(1);
        }
        if let Some(target_index) = next {
            self.pending_by_target[target_index] += self.target_output_amounts[target_index];
            self.job_count += 1;
        }
        self.row_job_targets[row] = next;
    }

    fn row_identity_matches(&self, state: &CoreState, entities: &[Value], row: usize) -> bool {
        let Some(&entity_index) = self.center_indices.get(row) else {
            return false;
        };
        let Some(entity) = entities.get(entity_index).and_then(Value::as_object) else {
            return false;
        };
        if entity_index >= state.entities.ids.len() {
            return false;
        }
        let indexed_id = &state.entities.ids[entity_index];
        let Some(indexed_building) = state.entities.buildings.get(entity_index) else {
            return false;
        };
        let Some(&group) = self.row_power_groups.get(row) else {
            return false;
        };
        let planet_index = group / POWER_GROUPS_PER_PLANET;
        let local_group = group % POWER_GROUPS_PER_PLANET;
        let grid_index = local_group / 3;
        let priority = local_group % 3 + 1;
        let expected_grid_id = match grid_index {
            0 => "grid-a",
            1 => "grid-b",
            2 => "grid-c",
            _ => return false,
        };
        string_at(entity, "id") == Some(indexed_id)
            && string_at(entity, "buildingId") == Some("construction_center")
            && state.symbols.resolve(*indexed_building) == Some("construction_center")
            && self.row_planets.get(row).copied() == Some(planet_index)
            && state
                .catalog
                .planets
                .get(planet_index)
                .is_some_and(|planet| string_at(entity, "planetId") == Some(planet.id.as_str()))
            && entity_grid_id(entity) == expected_grid_id
            && finite_number(entity.get("powerPriority"))
                .floor()
                .clamp(1.0, 3.0) as usize
                == priority
            && self.row_machine_count_bits.get(row).copied()
                == Some(finite_number(entity.get("machineCount")).to_bits())
    }

    fn row_matches(
        &self,
        state: &CoreState,
        entities: &[Value],
        power_factors: &HashMap<usize, f64>,
        row: usize,
    ) -> bool {
        if !self.row_identity_matches(state, entities, row) {
            return false;
        }
        let Some(&entity_index) = self.center_indices.get(row) else {
            return false;
        };
        let Some(&group) = self.row_power_groups.get(row) else {
            return false;
        };
        let Some(representative) = self
            .power_group_representatives
            .get(group)
            .copied()
            .flatten()
        else {
            return false;
        };
        let factor_entity = if self.aggregated_power_factors {
            representative
        } else {
            entity_index
        };
        matches!(
            (
                power_factor_signature(power_factors, factor_entity),
                power_factor_signature(power_factors, representative),
            ),
            (Some(left), Some(right)) if left == right
        )
    }

    fn refresh_dependency_wakes(
        &mut self,
        state: &CoreState,
        base: &Map<String, Value>,
    ) -> Option<bool> {
        let Ok(signature) = self.dependency_signature(state, base) else {
            self.fallback_full_scan = true;
            return None;
        };
        if let Some(previous) = self.observed_dependency.as_ref() {
            if previous.broad_dependencies_changed(&signature) {
                self.all_pending = true;
                self.pending.clear();
            } else if previous.cursor != signature.cursor && !self.all_pending {
                self.pending.extend(self.planner_wait_rows.iter().copied());
            }
        }
        let has_work = signature.has_work;
        self.observed_dependency = Some(signature);
        Some(has_work)
    }

    fn wake_dependency_changes(
        &mut self,
        state: &CoreState,
        base: &Map<String, Value>,
        power_factors: &HashMap<usize, f64>,
    ) {
        if self.refresh_dependency_wakes(state, base).is_none() {
            return;
        }

        for &group in &self.active_power_groups {
            let Some(representative) = self.power_group_representatives[group] else {
                continue;
            };
            let Some(signature) = power_factor_signature(power_factors, representative) else {
                self.fallback_full_scan = true;
                return;
            };
            if self.observed_power[group].is_some_and(|previous| previous != signature)
                && !self.all_pending
            {
                self.pending
                    .extend(self.power_group_rows[group].iter().copied());
            }
            self.observed_power[group] = Some(signature);
        }
        self.refresh_planet_inventory_wakes(base);
    }

    /// Refresh the O(target) global work signature before the factory power
    /// pass and return one row per occupied power bucket. A caller may use the
    /// aggregates only after also proving that every non-construction demand
    /// in the same power fold is a non-negative safe integer; otherwise it
    /// must retain the historical per-center registration path.
    pub(crate) fn power_demand_plan(
        &mut self,
        state: &CoreState,
        base: &Map<String, Value>,
        entities: &[Value],
        center_indices: &[usize],
        power_demand_multiplier: f64,
    ) -> ConstructionPowerDemandPlan {
        self.aggregated_power_factors = false;
        if !self.fallback_full_scan && self.topology_matches(state, entities, center_indices) {
            let representatives_match = self.active_power_groups.iter().all(|&group| {
                self.power_group_representatives
                    .get(group)
                    .copied()
                    .flatten()
                    .and_then(|entity_index| self.row_for_entity(entity_index))
                    .is_some_and(|row| self.row_identity_matches(state, entities, row))
            });
            if !representatives_match {
                self.fallback_full_scan = true;
            }
        }
        let indexed_has_deficit =
            if self.fallback_full_scan || !self.topology_matches(state, entities, center_indices) {
                self.fallback_full_scan = true;
                None
            } else {
                self.refresh_dependency_wakes(state, base)
            };
        let Some(has_deficit) = indexed_has_deficit else {
            return ConstructionPowerDemandPlan {
                has_deficit: has_deficit(state, base),
                aggregate_candidate: false,
                directory_fallback: true,
                groups: Vec::new(),
            };
        };
        if !has_deficit {
            return ConstructionPowerDemandPlan {
                has_deficit: false,
                aggregate_candidate: true,
                directory_fallback: false,
                groups: Vec::new(),
            };
        }
        let pending_rows = if self.all_pending {
            center_indices.len()
        } else {
            self.pending.len()
        };
        let dense = pending_rows > 0
            && pending_rows.saturating_mul(CONSTRUCTION_ACTIVE_DENSE_DENOMINATOR)
                >= center_indices
                    .len()
                    .saturating_mul(CONSTRUCTION_ACTIVE_DENSE_NUMERATOR);
        if dense {
            return ConstructionPowerDemandPlan {
                has_deficit: true,
                aggregate_candidate: false,
                directory_fallback: false,
                groups: Vec::new(),
            };
        }
        let Some(variant) = CONSTRUCTION_POWER_MULTIPLIERS
            .iter()
            .position(|candidate| candidate.to_bits() == power_demand_multiplier.to_bits())
        else {
            return ConstructionPowerDemandPlan {
                has_deficit: true,
                aggregate_candidate: false,
                directory_fallback: false,
                groups: Vec::new(),
            };
        };
        if !self.power_variant_exact[variant] {
            return ConstructionPowerDemandPlan {
                has_deficit: true,
                aggregate_candidate: false,
                directory_fallback: false,
                groups: Vec::new(),
            };
        }
        let mut groups = Vec::with_capacity(self.active_power_groups.len());
        for &group in &self.active_power_groups {
            let Some(representative_entity_index) = self.power_group_representatives[group] else {
                self.fallback_full_scan = true;
                return ConstructionPowerDemandPlan {
                    has_deficit: true,
                    aggregate_candidate: false,
                    directory_fallback: true,
                    groups: Vec::new(),
                };
            };
            let local_group = group % POWER_GROUPS_PER_PLANET;
            groups.push(ConstructionPowerGroupDemand {
                representative_entity_index,
                planet_index: group / POWER_GROUPS_PER_PLANET,
                grid_index: local_group / 3,
                priority: local_group % 3 + 1,
                demand_kw: self.power_group_demands[variant][group],
                center_count: self.power_group_center_counts[group],
            });
        }
        ConstructionPowerDemandPlan {
            has_deficit: true,
            aggregate_candidate: true,
            directory_fallback: false,
            groups,
        }
    }

    pub(crate) fn use_aggregated_power_factors(&mut self, enabled: bool) {
        self.aggregated_power_factors = enabled && !self.fallback_full_scan;
    }

    fn cached_all_centers_provably_unpowered(&self, state: &CoreState) -> Option<bool> {
        (!self.fallback_full_scan
            && Arc::ptr_eq(&self.topology, &state.factory_topology)
            && Arc::ptr_eq(&self.catalog, &state.catalog))
        .then_some(self.provably_unpowered)
        .flatten()
    }

    fn refresh_planet_inventory_wakes(&mut self, base: &Map<String, Value>) {
        for planet_index in 0..self.planet_wait_rows.len() {
            if self.planet_wait_rows[planet_index].is_empty() {
                self.observed_planet_inventory[planet_index] = None;
                continue;
            }
            let Some(planet_id) = self
                .catalog
                .planets
                .get(planet_index)
                .map(|planet| &planet.id)
            else {
                self.fallback_full_scan = true;
                return;
            };
            let Some(current) = planet_inventory_fingerprint(base, planet_id) else {
                self.fallback_full_scan = true;
                return;
            };
            if self.observed_planet_inventory[planet_index]
                .as_ref()
                .is_some_and(|previous| planet_inventory_increased(previous, &current))
                && !self.all_pending
            {
                self.pending
                    .extend(self.planet_wait_rows[planet_index].iter().copied());
            }
            self.observed_planet_inventory[planet_index] = Some(current);
        }
    }

    fn selected_rows(
        &mut self,
        state: &CoreState,
        base: &Map<String, Value>,
        entities: &[Value],
        power_factors: &HashMap<usize, f64>,
        center_indices: &[usize],
    ) -> (Vec<usize>, ConstructionActiveScan) {
        if !self.fallback_full_scan && self.topology_matches(state, entities, center_indices) {
            self.wake_dependency_changes(state, base, power_factors);
        }
        let total_rows = center_indices.len();
        if self.fallback_full_scan || !self.topology_matches(state, entities, center_indices) {
            self.fallback_full_scan = true;
            return (
                center_indices.to_vec(),
                ConstructionActiveScan {
                    selected_rows: total_rows,
                    total_rows,
                    dense_fallback: true,
                    directory_fallback: true,
                },
            );
        }
        let pending_rows = if self.all_pending {
            total_rows
        } else {
            self.pending.len()
        };
        let dense_fallback = pending_rows > 0
            && pending_rows.saturating_mul(CONSTRUCTION_ACTIVE_DENSE_DENOMINATOR)
                >= total_rows.saturating_mul(CONSTRUCTION_ACTIVE_DENSE_NUMERATOR);
        let rows = if self.all_pending || dense_fallback {
            (0..total_rows).collect::<Vec<_>>()
        } else {
            self.pending.iter().copied().collect::<Vec<_>>()
        };
        if rows
            .iter()
            .any(|&row| !self.row_matches(state, entities, power_factors, row))
        {
            self.fallback_full_scan = true;
            return (
                center_indices.to_vec(),
                ConstructionActiveScan {
                    selected_rows: total_rows,
                    total_rows,
                    dense_fallback: true,
                    directory_fallback: true,
                },
            );
        }
        self.all_pending = false;
        for &row in &rows {
            self.pending.remove(&row);
            self.planner_wait_rows.remove(&row);
            if let Some(&planet) = self.row_planets.get(row) {
                self.planet_wait_rows[planet].remove(&row);
            }
        }
        let selected = rows
            .iter()
            .filter_map(|&row| self.center_indices.get(row).copied())
            .collect::<Vec<_>>();
        (
            selected,
            ConstructionActiveScan {
                selected_rows: rows.len(),
                total_rows,
                dense_fallback,
                directory_fallback: false,
            },
        )
    }

    fn finish_center(
        &mut self,
        base: &Map<String, Value>,
        entity_index: usize,
        keep_active: bool,
        wait_for_planet_inventory: bool,
        wait_for_planner_cursor: bool,
    ) {
        if self.fallback_full_scan {
            return;
        }
        let Some(row) = self.row_for_entity(entity_index) else {
            self.fallback_full_scan = true;
            return;
        };
        if keep_active {
            self.pending.insert(row);
            return;
        }
        if wait_for_planner_cursor {
            self.planner_wait_rows.insert(row);
        }
        if wait_for_planet_inventory {
            let planet_index = self.row_planets[row];
            if self.observed_planet_inventory[planet_index].is_none() {
                let Some(planet_id) = self
                    .catalog
                    .planets
                    .get(planet_index)
                    .map(|planet| &planet.id)
                else {
                    self.fallback_full_scan = true;
                    return;
                };
                let Some(fingerprint) = planet_inventory_fingerprint(base, planet_id) else {
                    self.fallback_full_scan = true;
                    return;
                };
                self.observed_planet_inventory[planet_index] = Some(fingerprint);
            }
            self.planet_wait_rows[planet_index].insert(row);
        }
    }

    fn commit_dependencies(&mut self, state: &CoreState, base: &Map<String, Value>) {
        if self.fallback_full_scan {
            return;
        }
        self.refresh_dependency_wakes(state, base);
        self.refresh_planet_inventory_wakes(base);
    }

    pub(crate) fn wake_center_indices(&mut self, center_indices: &[usize]) {
        if self.fallback_full_scan || self.all_pending {
            return;
        }
        for &entity_index in center_indices {
            let Some(row) = self.row_for_entity(entity_index) else {
                self.fallback_full_scan = true;
                self.pending.clear();
                return;
            };
            self.pending.insert(row);
        }
    }

    pub(crate) fn wake_all(&mut self) {
        if !self.fallback_full_scan {
            self.all_pending = true;
            self.pending.clear();
        }
    }

    pub(crate) fn estimated_bytes(&self) -> u64 {
        use std::mem::size_of;

        // Runtime is Arc-owned. Count its inline allocation and the two Arc
        // reference counters in addition to every separately allocated
        // buffer below. Nested Vec/BTreeSet headers live in their outer Vec
        // allocation, not in `Self`, so they must be counted explicitly.
        let runtime_allocation = size_of::<Self>() + size_of::<usize>() * 2;
        let power_row_buffers = self
            .power_group_rows
            .iter()
            .map(|rows| rows.capacity())
            .sum::<usize>()
            * size_of::<usize>();
        let nested_container_buffers = self.power_group_rows.capacity() * size_of::<Vec<usize>>()
            + self.planet_wait_rows.capacity() * size_of::<BTreeSet<usize>>()
            + self.observed_planet_inventory.capacity() * size_of::<Option<Vec<(String, u64)>>>();
        // Rust's B-tree node layout is deliberately private. Charge a full
        // root/allocation allowance to every non-empty Set, then four machine
        // words per live key for keys, links, occupancy, and additional-node
        // slack. This intentionally overestimates sparse one-key wait sets
        // instead of pretending a Set is a packed Vec.
        let tree_entry_bytes = size_of::<usize>() * 4;
        let tree_root_bytes = size_of::<usize>() * 16;
        let tree_bytes = |rows: &BTreeSet<usize>| {
            if rows.is_empty() {
                0
            } else {
                tree_root_bytes + rows.len() * tree_entry_bytes
            }
        };
        let planet_wait_tree_bytes = self.planet_wait_rows.iter().map(tree_bytes).sum::<usize>();
        let pending_tree_bytes = tree_bytes(&self.planner_wait_rows) + tree_bytes(&self.pending);
        let inventory_entry_buffers = self
            .observed_planet_inventory
            .iter()
            .flatten()
            .map(|entries| entries.capacity() * size_of::<(String, u64)>())
            .sum::<usize>();
        let inventory_text_bytes = self
            .observed_planet_inventory
            .iter()
            .flatten()
            .flat_map(|entries| entries.iter())
            .map(|(item_id, _)| item_id.capacity())
            .sum::<usize>();
        let target_lookup_bytes = self
            .target_by_id
            .keys()
            .map(|target_id| {
                target_id.capacity() + size_of::<(String, usize)>() + size_of::<usize>() * 4
            })
            .sum::<usize>()
            + usize::from(!self.target_by_id.is_empty()) * size_of::<usize>() * 64;
        let dependency_bytes = self
            .observed_dependency
            .as_ref()
            .map(|signature| {
                signature
                    .completed_tech_ids
                    .iter()
                    .map(String::capacity)
                    .sum::<usize>()
                    + signature.completed_tech_ids.capacity() * size_of::<String>()
                    + signature.target_limits.capacity() * size_of::<u64>()
                    + signature.active_targets.capacity() * size_of::<bool>()
            })
            .unwrap_or(0);
        let receipt_history_bytes = self.receipt_history.capacity()
            * size_of::<VersionedConstructionRunReceipt>()
            + self
                .receipt_history
                .iter()
                .map(|entry| {
                    let outputs = &entry.receipt.outputs;
                    outputs.keys().map(String::capacity).sum::<usize>()
                        + outputs.len() * (size_of::<(String, i128)>() + size_of::<usize>() * 4)
                        + usize::from(!outputs.is_empty()) * size_of::<usize>() * 16
                })
                .sum::<usize>();
        (runtime_allocation
            + self.center_indices.capacity() * size_of::<usize>()
            + self.row_by_entity.capacity() * size_of::<(u32, u32)>()
            + self.row_planets.capacity() * size_of::<usize>()
            + self.row_power_groups.capacity() * size_of::<usize>()
            + self.row_machine_count_bits.capacity() * size_of::<u64>()
            + self.target_ids.iter().map(String::capacity).sum::<usize>()
            + self.target_ids.capacity() * size_of::<String>()
            + self.target_output_amounts.capacity() * size_of::<f64>()
            + target_lookup_bytes
            + self.row_job_targets.capacity() * size_of::<Option<usize>>()
            + self.pending_by_target.capacity() * size_of::<f64>()
            + nested_container_buffers
            + power_row_buffers
            + self.active_power_groups.capacity() * size_of::<usize>()
            + self.power_group_center_counts.capacity() * size_of::<usize>()
            + self
                .power_group_demands
                .iter()
                .map(|demands| demands.capacity())
                .sum::<usize>()
                * size_of::<f64>()
            + self.power_group_representatives.capacity() * size_of::<Option<usize>>()
            + self.observed_power.capacity() * size_of::<Option<PowerFactorSignature>>()
            + planet_wait_tree_bytes
            + pending_tree_bytes
            + inventory_entry_buffers
            + inventory_text_bytes
            + dependency_bytes
            + receipt_history_bytes) as u64
    }

    #[cfg(test)]
    pub(crate) fn force_full_scan(&mut self) {
        self.fallback_full_scan = true;
    }
}

fn power_factor_signature(
    power_factors: &HashMap<usize, f64>,
    entity_index: usize,
) -> Option<PowerFactorSignature> {
    let Some(factor) = power_factors.get(&entity_index).copied() else {
        return Some(PowerFactorSignature::Missing);
    };
    if !factor.is_finite() {
        return None;
    }
    // `run_centers` gates work on the unrounded factor and also multiplies
    // work by that exact value. Keep its complete IEEE-754 representation so
    // two factors in the same four-decimal display bucket (including values
    // on opposite sides of EPSILON) cannot leave a sleeping center stale.
    Some(PowerFactorSignature::Value(factor.to_bits()))
}

fn planet_inventory_fingerprint(
    base: &Map<String, Value>,
    planet_id: &str,
) -> Option<Vec<(String, u64)>> {
    let inventory = tray(base, planet_id)?;
    let mut fingerprint = inventory
        .iter()
        .map(|(item_id, amount)| {
            (
                item_id.clone(),
                floor_amount(finite_number(Some(amount))) as u64,
            )
        })
        .collect::<Vec<_>>();
    fingerprint.sort_unstable_by(|left, right| left.0.cmp(&right.0));
    Some(fingerprint)
}

fn planet_inventory_increased(previous: &[(String, u64)], current: &[(String, u64)]) -> bool {
    let mut previous_index = 0;
    for (item_id, amount) in current {
        while previous_index < previous.len() && previous[previous_index].0 < *item_id {
            previous_index += 1;
        }
        let old = previous
            .get(previous_index)
            .filter(|(candidate, _)| candidate == item_id)
            .map(|(_, amount)| *amount)
            .unwrap_or(0);
        if *amount > old {
            return true;
        }
    }
    false
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct RequirementReservation {
    available: bool,
    changed: bool,
}

fn finite_number(value: Option<&Value>) -> f64 {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .unwrap_or(0.0)
}

pub(crate) fn nonnegative_safe_integer(value: f64) -> bool {
    value.is_finite() && (0.0..=MAX_SAFE_INTEGER).contains(&value) && value.trunc() == value
}

fn string_at<'a>(object: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    object.get(key).and_then(Value::as_str)
}

fn set_number(object: &mut Map<String, Value>, key: &str, value: f64) -> anyhow::Result<()> {
    let value = Number::from_f64(value)
        .map(Value::Number)
        .ok_or_else(|| anyhow!("native construction produced a non-finite number"))?;
    if let Some(target) = object.get_mut(key) {
        *target = value;
    } else {
        object.insert(key.to_owned(), value);
    }
    Ok(())
}

fn floor_amount(value: f64) -> f64 {
    if value.is_finite() {
        value.floor().clamp(0.0, MAX_SAFE_INTEGER)
    } else {
        0.0
    }
}

fn inventory_amount(inventory: &Map<String, Value>, item_id: &str) -> f64 {
    floor_amount(finite_number(inventory.get(item_id)))
}

fn set_inventory_amount(
    inventory: &mut Map<String, Value>,
    item_id: &str,
    amount: f64,
) -> anyhow::Result<()> {
    inventory.insert(
        item_id.to_owned(),
        Number::from_f64(floor_amount(amount))
            .map(Value::Number)
            .ok_or_else(|| anyhow!("native construction inventory is non-finite"))?,
    );
    Ok(())
}

fn automation(base: &Map<String, Value>) -> anyhow::Result<&Map<String, Value>> {
    base.get("constructionAutomation")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native construction automation state is missing"))
}

fn completed_tech(base: &Map<String, Value>, id: &str) -> bool {
    base.get("research")
        .and_then(Value::as_object)
        .and_then(|research| research.get("completedTechIds"))
        .and_then(Value::as_array)
        .is_some_and(|ids| ids.iter().any(|value| value.as_str() == Some(id)))
}

fn cycle_seconds(base: &Map<String, Value>) -> f64 {
    if completed_tech(base, "construction_capacity_2") {
        1.0
    } else if completed_tech(base, "construction_capacity_1") {
        2.5
    } else {
        5.0
    }
}

fn parse_step(value: &Value) -> anyhow::Result<Step> {
    let step = value
        .as_object()
        .ok_or_else(|| anyhow!("native construction step is invalid"))?;
    match string_at(step, "kind") {
        Some("material") => Ok(Step::Material {
            recipe_id: string_at(step, "recipeId")
                .ok_or_else(|| anyhow!("native construction material recipe is missing"))?
                .to_owned(),
            batches: floor_amount(finite_number(step.get("batches"))),
            output_item_id: string_at(step, "outputItemId")
                .ok_or_else(|| anyhow!("native construction material output item is missing"))?
                .to_owned(),
            output_amount: floor_amount(finite_number(step.get("outputAmount"))),
        }),
        Some("building") => Ok(Step::Building {
            construction_id: string_at(step, "constructionId")
                .ok_or_else(|| anyhow!("native construction building ID is missing"))?
                .to_owned(),
        }),
        Some("fleet") => Ok(Step::Fleet {
            item_id: string_at(step, "itemId")
                .ok_or_else(|| anyhow!("native construction fleet item is missing"))?
                .to_owned(),
            amount: floor_amount(finite_number(step.get("amount"))),
        }),
        _ => bail!("native construction step kind is invalid"),
    }
}

fn requirements_from_catalog(
    catalog: &RuntimeCatalog,
    step: &Step,
) -> anyhow::Result<Vec<ItemAmount>> {
    match step {
        Step::Building { construction_id } => catalog
            .constructions
            .get(construction_id)
            .map(|definition| definition.costs.clone())
            .ok_or_else(|| anyhow!("native construction definition is missing")),
        Step::Material {
            recipe_id,
            batches,
            output_item_id,
            ..
        } => catalog
            .recipes
            .get(recipe_id)
            .filter(|recipe| {
                recipe
                    .outputs
                    .iter()
                    .any(|output| output.item_id == *output_item_id)
            })
            .map(|recipe| {
                recipe
                    .inputs
                    .iter()
                    .map(|input| ItemAmount {
                        item_id: input.item_id.clone(),
                        amount: floor_amount(input.amount * batches),
                    })
                    .collect()
            })
            .ok_or_else(|| anyhow!("native construction material recipe is missing")),
        Step::Fleet { item_id, amount } => Ok(vec![ItemAmount {
            item_id: item_id.clone(),
            amount: *amount,
        }]),
    }
}

fn requirements(state: &CoreState, step: &Step) -> anyhow::Result<Vec<ItemAmount>> {
    requirements_from_catalog(state.catalog.as_ref(), step)
}

fn step_duration(state: &CoreState, base: &Map<String, Value>, step: &Step) -> anyhow::Result<f64> {
    match step {
        Step::Building { .. } => Ok(cycle_seconds(base)),
        Step::Material {
            recipe_id,
            output_amount,
            ..
        } => {
            if !state.catalog.recipes.contains_key(recipe_id) {
                bail!("native construction material recipe is missing");
            }
            Ok((0.1 * cycle_seconds(base) / 5.0 * output_amount).max(0.01))
        }
        Step::Fleet { .. } => Ok(0.01),
    }
}

fn tray<'a>(base: &'a Map<String, Value>, planet_id: &str) -> Option<&'a Map<String, Value>> {
    if base.get("activePlanetId").and_then(Value::as_str) == Some(planet_id) {
        base.get("tray").and_then(Value::as_object)
    } else {
        base.get("planetTrays")
            .and_then(Value::as_object)
            .and_then(|trays| trays.get(planet_id))
            .and_then(Value::as_object)
    }
}

fn tray_mut<'a>(
    base: &'a mut Map<String, Value>,
    planet_id: &str,
) -> Option<&'a mut Map<String, Value>> {
    if base.get("activePlanetId").and_then(Value::as_str) == Some(planet_id) {
        base.get_mut("tray").and_then(Value::as_object_mut)
    } else {
        base.get_mut("planetTrays")
            .and_then(Value::as_object_mut)
            .and_then(|trays| trays.get_mut(planet_id))
            .and_then(Value::as_object_mut)
    }
}

fn quantum_buffer<'a>(
    automation: &'a Map<String, Value>,
    entity_id: &str,
) -> Option<&'a Map<String, Value>> {
    automation
        .get("quantumMaterialBuffer")
        .and_then(Value::as_object)
        .and_then(|buffers| buffers.get(entity_id))
        .and_then(Value::as_object)
}

fn entity_grid_id(entity: &Map<String, Value>) -> &str {
    string_at(entity, "powerGridId").unwrap_or("grid-a")
}

/// A construction center with no possible producer on its planet/grid is an
/// exact dormant domain: both authorities only clear its runtime power and
/// activity fields, without parsing, planning or consuming its saved job.
/// Keep this proof deliberately conservative. A potential ray receiver or any
/// power entity makes the domain active even when it currently lacks fuel.
fn all_centers_provably_unpowered(state: &CoreState) -> anyhow::Result<bool> {
    if let Some(proof) = state
        .prepared_construction_runtime()
        .and_then(|runtime| runtime.cached_all_centers_provably_unpowered(state))
    {
        return Ok(proof);
    }
    let relevant = (0..state.entity_index.len())
        .filter(|&index| {
            let building = state.symbols.resolve(state.entities.buildings[index]);
            let kind = state.symbols.resolve(state.entities.kinds[index]);
            let recipe = state.symbols.resolve(state.entities.recipes[index]);
            building == Some("construction_center")
                || kind == Some("power")
                || building == Some("ray_receiver") && recipe == Some("ray_power")
        })
        .map(|index| state.parse_entity(index))
        .collect::<anyhow::Result<Vec<_>>>()?;
    let center_grids = relevant
        .iter()
        .filter_map(Value::as_object)
        .filter(|entity| string_at(entity, "buildingId") == Some("construction_center"))
        .map(|entity| {
            (
                string_at(entity, "planetId").unwrap_or_default().to_owned(),
                entity_grid_id(entity).to_owned(),
            )
        })
        .collect::<std::collections::HashSet<_>>();
    if center_grids.is_empty() {
        return Ok(false);
    }
    let has_possible_source = relevant.iter().filter_map(Value::as_object).any(|entity| {
        let key = (
            string_at(entity, "planetId").unwrap_or_default().to_owned(),
            entity_grid_id(entity).to_owned(),
        );
        center_grids.contains(&key)
            && (string_at(entity, "kind") == Some("power")
                || (string_at(entity, "buildingId") == Some("ray_receiver")
                    && string_at(entity, "recipeId") == Some("ray_power")))
    });
    Ok(!has_possible_source)
}

fn current_stock(base: &Map<String, Value>, construction_id: &str) -> f64 {
    let inventory = if matches!(construction_id, "logistics_drone" | "logistics_vessel") {
        base.get("portableFleet")
    } else {
        base.get("construction")
    };
    inventory
        .and_then(Value::as_object)
        .and_then(|inventory| inventory.get(construction_id))
        .map(|value| floor_amount(finite_number(Some(value))))
        .unwrap_or(0.0)
}

fn pending_stock_in_jobs(
    state: &CoreState,
    jobs: &Map<String, Value>,
    construction_id: &str,
) -> f64 {
    jobs.values()
        .filter_map(Value::as_object)
        .filter(|job| string_at(job, "constructionId") == Some(construction_id))
        .map(|_| {
            if matches!(construction_id, "logistics_drone" | "logistics_vessel") {
                state
                    .catalog
                    .recipes
                    .get(construction_id)
                    .and_then(|recipe| {
                        recipe
                            .outputs
                            .iter()
                            .find(|output| output.item_id == construction_id)
                    })
                    .map(|output| output.amount)
                    .unwrap_or(0.0)
            } else {
                state
                    .catalog
                    .constructions
                    .get(construction_id)
                    .map(|definition| definition.output_amount)
                    .unwrap_or(0.0)
            }
        })
        .sum()
}

fn construction_dependency_signature(
    runtime: &ConstructionRuntime,
    state: &CoreState,
    base: &Map<String, Value>,
) -> anyhow::Result<ConstructionDependencySignature> {
    let automation = automation(base)?;
    let enabled = automation.get("enabled").and_then(Value::as_bool) == Some(true);
    let targets = crate::construction_planner::targets(state);
    if targets.len() != runtime.target_ids.len()
        || targets
            .iter()
            .zip(&runtime.target_ids)
            .any(|(target, target_id)| target.id != *target_id)
    {
        bail!("native construction target directory is stale");
    }
    let target_stock = automation.get("targetStock").and_then(Value::as_object);
    let mut target_limits = Vec::with_capacity(targets.len());
    let mut active_targets = Vec::with_capacity(targets.len());
    let mut unlocked_target_deficit = false;
    for (target_index, target) in targets.iter().enumerate() {
        let desired = target_stock
            .map(|stock| floor_amount(finite_number(stock.get(&target.id))))
            .unwrap_or(0.0);
        let pending = runtime.pending_by_target[target_index];
        let deficit = desired > current_stock(base, &target.id) + pending;
        let unlocked = crate::construction_planner::target_is_unlocked(base, target);
        unlocked_target_deficit |= deficit && unlocked;
        target_limits.push(desired as u64);
        active_targets.push(enabled && deficit && unlocked);
    }
    let mut completed_tech_ids =
        base.get("research")
            .and_then(Value::as_object)
            .and_then(|research| research.get("completedTechIds"))
            .and_then(Value::as_array)
            .ok_or_else(|| anyhow!("native construction completed technology list is missing"))?
            .iter()
            .map(|value| {
                value.as_str().map(str::to_owned).ok_or_else(|| {
                    anyhow!("native construction completed technology ID is invalid")
                })
            })
            .collect::<anyhow::Result<Vec<_>>>()?;
    completed_tech_ids.sort_unstable();
    completed_tech_ids.dedup();
    let raw_cursor = finite_number(automation.get("cursor")).trunc();
    let cursor = if targets.is_empty() || !raw_cursor.is_finite() {
        0
    } else {
        raw_cursor.rem_euclid(targets.len() as f64) as usize
    };
    Ok(ConstructionDependencySignature {
        enabled,
        mode_normal: base.get("mode").and_then(Value::as_str) == Some("normal"),
        orbital_station_locked: base
            .get("orbitalStation")
            .and_then(Value::as_object)
            .and_then(|station| station.get("status"))
            .and_then(Value::as_str)
            == Some("locked"),
        completed_tech_ids,
        target_limits,
        active_targets,
        has_work: enabled
            && (runtime.job_count > 0
                || automation
                    .get("quantumMaterialBuffer")
                    .and_then(Value::as_object)
                    .is_some_and(|buffers| !buffers.is_empty())
                || unlocked_target_deficit),
        cursor,
    })
}

fn select_target(
    state: &CoreState,
    base: &Map<String, Value>,
    automation: &Map<String, Value>,
    jobs: &Map<String, Value>,
) -> Option<crate::construction_planner::Target> {
    let targets = crate::construction_planner::targets(state);
    if targets.is_empty() {
        return None;
    }
    let raw_cursor = finite_number(automation.get("cursor")).trunc();
    let cursor = if raw_cursor.is_finite() {
        raw_cursor.rem_euclid(targets.len() as f64) as usize
    } else {
        0
    };
    let target_stock = automation.get("targetStock").and_then(Value::as_object)?;
    for offset in 0..targets.len() {
        let target = &targets[(cursor + offset) % targets.len()];
        let desired = floor_amount(finite_number(target_stock.get(&target.id)));
        let current =
            current_stock(base, &target.id) + pending_stock_in_jobs(state, jobs, &target.id);
        if desired > current && crate::construction_planner::target_is_unlocked(base, target) {
            return Some(target.clone());
        }
    }
    None
}

fn planned_step_value(step: crate::construction_planner::PlannedStep) -> Value {
    match step {
        crate::construction_planner::PlannedStep::Material {
            recipe_id,
            batches,
            output_item_id,
            output_amount,
        } => serde_json::json!({
            "kind": "material",
            "recipeId": recipe_id,
            "batches": batches,
            "outputItemId": output_item_id,
            "outputAmount": output_amount,
        }),
        crate::construction_planner::PlannedStep::Building { construction_id } => {
            serde_json::json!({
                "kind": "building",
                "constructionId": construction_id,
            })
        }
        crate::construction_planner::PlannedStep::Fleet { item_id, amount } => serde_json::json!({
            "kind": "fleet",
            "itemId": item_id,
            "amount": amount,
        }),
    }
}

fn planned_job_value(
    target: &crate::construction_planner::Target,
    plan: crate::construction_planner::Plan,
) -> Value {
    let decisions = plan
        .decisions
        .into_iter()
        .map(|decision| {
            let mut value = Map::new();
            value.insert("itemId".to_owned(), Value::from(decision.item_id));
            value.insert("recipeId".to_owned(), Value::from(decision.recipe_id));
            if let Some(reason) = decision.fallback_reason {
                value.insert("fallbackReason".to_owned(), Value::from(reason));
            }
            Value::Object(value)
        })
        .collect::<Vec<_>>();
    serde_json::json!({
        "constructionId": target.id,
        "steps": plan.steps.into_iter().map(planned_step_value).collect::<Vec<_>>(),
        "stepIndex": 0,
        "elapsedSeconds": 0,
        "inventory": {},
        "recipeDecisions": decisions,
    })
}

#[derive(Debug, Clone)]
struct RepeatableBatch {
    jobs_per_cycle: usize,
    work_seconds: f64,
    tray_costs: BTreeMap<String, f64>,
    tray_returns: BTreeMap<String, f64>,
    fleet_returns: BTreeMap<String, f64>,
    produced_items: BTreeMap<String, f64>,
    relevant_items: BTreeSet<String>,
    touched_tray_items: BTreeSet<String>,
    cycle_state_items: Vec<String>,
    cycle_start_inventory: BTreeMap<String, f64>,
}

#[derive(Debug, Clone)]
struct ResolvedConstructionPlan {
    plan: crate::construction_planner::Plan,
    batch: Option<RepeatableBatch>,
}

#[derive(Debug, Clone, Copy)]
struct ConstructionComputeBudget {
    remaining_iterations: usize,
    remaining_plan_builds: usize,
}

fn safe_multiply(left: f64, right: f64) -> f64 {
    let left = floor_amount(left);
    let right = floor_amount(right);
    if left < 1.0 || right < 1.0 {
        0.0
    } else if left > (MAX_SAFE_INTEGER / right).floor() {
        MAX_SAFE_INTEGER
    } else {
        left * right
    }
}

fn safe_add(left: f64, right: f64) -> f64 {
    let left = floor_amount(left);
    let right = floor_amount(right);
    if left > MAX_SAFE_INTEGER - right {
        MAX_SAFE_INTEGER
    } else {
        left + right
    }
}

fn analyze_repeatable_plan(
    state: &CoreState,
    base: &Map<String, Value>,
    target: &crate::construction_planner::Target,
    plan: &crate::construction_planner::Plan,
) -> anyhow::Result<Option<RepeatableBatch>> {
    if plan.steps.is_empty() {
        return Ok(None);
    }
    let job_value = planned_job_value(target, plan.clone());
    let job = job_value
        .as_object()
        .ok_or_else(|| anyhow!("native construction batch job is invalid"))?;
    let mut inventory = Map::new();
    let mut tray_costs = BTreeMap::<String, f64>::new();
    let mut tray_returns = BTreeMap::<String, f64>::new();
    let mut fleet_returns = BTreeMap::<String, f64>::new();
    let mut produced_items = BTreeMap::<String, f64>::new();
    let mut relevant_items = BTreeSet::<String>::new();
    let mut touched_tray_items = BTreeSet::<String>::new();
    let mut work_seconds = 0.0;
    let values = job
        .get("steps")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("native construction batch steps are missing"))?;
    for (step_index, value) in values.iter().enumerate() {
        let step = parse_step(value)?;
        work_seconds += step_duration(state, base, &step)?;
        for requirement in requirements(state, &step)? {
            relevant_items.insert(requirement.item_id.clone());
            touched_tray_items.insert(requirement.item_id.clone());
            let mut remaining = floor_amount(requirement.amount);
            let available = inventory_amount(&inventory, &requirement.item_id);
            let consumed = remaining.min(available);
            set_inventory_amount(&mut inventory, &requirement.item_id, available - consumed)?;
            remaining -= consumed;
            if remaining > 0.0 {
                *tray_costs.entry(requirement.item_id).or_default() += remaining;
            }
        }
        if let Step::Material {
            recipe_id, batches, ..
        } = &step
        {
            let recipe = state
                .catalog
                .recipes
                .get(recipe_id)
                .ok_or_else(|| anyhow!("native construction batch recipe is missing"))?;
            for output in &recipe.outputs {
                let amount = floor_amount(output.amount * batches);
                let current = inventory_amount(&inventory, &output.item_id);
                set_inventory_amount(&mut inventory, &output.item_id, current + amount)?;
                *produced_items.entry(output.item_id.clone()).or_default() += amount;
            }
        }
        let needed = remaining_inventory_need(state, job, step_index + 1)?;
        let mut retained = Map::new();
        for (item_id, value) in inventory {
            let amount = floor_amount(finite_number(Some(&value)));
            let keep = amount.min(needed.get(&item_id).copied().unwrap_or(0.0));
            if keep > 0.0 {
                retained.insert(item_id.clone(), Value::from(keep));
            }
            let excess = amount - keep;
            if excess < 1.0 {
                continue;
            }
            if matches!(item_id.as_str(), "logistics_drone" | "logistics_vessel") {
                *fleet_returns.entry(item_id).or_default() += excess;
            } else {
                *tray_returns.entry(item_id).or_default() += excess;
            }
        }
        inventory = retained;
    }
    if inventory
        .values()
        .any(|amount| floor_amount(finite_number(Some(amount))) > 0.0)
    {
        return Ok(None);
    }
    Ok(Some(RepeatableBatch {
        jobs_per_cycle: 1,
        work_seconds,
        tray_costs,
        tray_returns,
        fleet_returns,
        produced_items,
        relevant_items,
        touched_tray_items,
        cycle_state_items: Vec::new(),
        cycle_start_inventory: BTreeMap::new(),
    }))
}

fn add_batch_amount(target: &mut BTreeMap<String, f64>, item_id: &str, amount: f64) {
    let amount = floor_amount(amount);
    if amount < 1.0 {
        return;
    }
    let current = target.get(item_id).copied().unwrap_or(0.0);
    target.insert(item_id.to_owned(), floor_amount(current + amount));
}

fn compose_repeatable_batches(
    first: &RepeatableBatch,
    second: &RepeatableBatch,
) -> RepeatableBatch {
    let material_items = first
        .tray_costs
        .keys()
        .chain(first.tray_returns.keys())
        .chain(second.tray_costs.keys())
        .chain(second.tray_returns.keys())
        .cloned()
        .collect::<BTreeSet<_>>();
    let mut tray_costs = BTreeMap::new();
    let mut tray_returns = BTreeMap::new();
    for item_id in material_items {
        let first_cost = floor_amount(first.tray_costs.get(&item_id).copied().unwrap_or(0.0));
        let first_return = floor_amount(first.tray_returns.get(&item_id).copied().unwrap_or(0.0));
        let second_cost = floor_amount(second.tray_costs.get(&item_id).copied().unwrap_or(0.0));
        let second_return = floor_amount(second.tray_returns.get(&item_id).copied().unwrap_or(0.0));
        // The first job's return is working capital for the second job. Keep
        // the exact prefix requirement and the final external return instead
        // of adding two independent net deltas.
        add_batch_amount(
            &mut tray_costs,
            &item_id,
            first_cost + (second_cost - first_return).max(0.0),
        );
        add_batch_amount(
            &mut tray_returns,
            &item_id,
            second_return + (first_return - second_cost).max(0.0),
        );
    }

    let mut fleet_returns = BTreeMap::new();
    for item_id in first
        .fleet_returns
        .keys()
        .chain(second.fleet_returns.keys())
        .cloned()
        .collect::<BTreeSet<_>>()
    {
        add_batch_amount(
            &mut fleet_returns,
            &item_id,
            first.fleet_returns.get(&item_id).copied().unwrap_or(0.0)
                + second.fleet_returns.get(&item_id).copied().unwrap_or(0.0),
        );
    }

    let mut produced_items = BTreeMap::new();
    for item_id in first
        .produced_items
        .keys()
        .chain(second.produced_items.keys())
        .cloned()
        .collect::<BTreeSet<_>>()
    {
        add_batch_amount(
            &mut produced_items,
            &item_id,
            first.produced_items.get(&item_id).copied().unwrap_or(0.0)
                + second.produced_items.get(&item_id).copied().unwrap_or(0.0),
        );
    }

    RepeatableBatch {
        jobs_per_cycle: first
            .jobs_per_cycle
            .max(1)
            .saturating_add(second.jobs_per_cycle.max(1)),
        work_seconds: first.work_seconds + second.work_seconds,
        tray_costs,
        tray_returns,
        fleet_returns,
        produced_items,
        relevant_items: first
            .relevant_items
            .union(&second.relevant_items)
            .cloned()
            .collect(),
        touched_tray_items: first
            .touched_tray_items
            .union(&second.touched_tray_items)
            .cloned()
            .collect(),
        cycle_state_items: first
            .cycle_state_items
            .iter()
            .chain(second.cycle_state_items.iter())
            .cloned()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect(),
        cycle_start_inventory: first.cycle_start_inventory.clone(),
    }
}

#[derive(Debug, Clone, PartialEq)]
struct RepeatableBatchSignature {
    work_seconds_bits: u64,
    tray_costs: BTreeMap<String, f64>,
    tray_returns: BTreeMap<String, f64>,
    fleet_returns: BTreeMap<String, f64>,
    produced_items: BTreeMap<String, f64>,
    relevant_items: BTreeSet<String>,
    touched_tray_items: BTreeSet<String>,
}

#[derive(Debug, Clone, PartialEq)]
struct ConstructionCycleFingerprint {
    batch: RepeatableBatchSignature,
    tray: Vec<(String, f64)>,
}

fn batch_signature(batch: &RepeatableBatch) -> RepeatableBatchSignature {
    RepeatableBatchSignature {
        work_seconds_bits: batch.work_seconds.to_bits(),
        tray_costs: batch.tray_costs.clone(),
        tray_returns: batch.tray_returns.clone(),
        fleet_returns: batch.fleet_returns.clone(),
        produced_items: batch.produced_items.clone(),
        relevant_items: batch.relevant_items.clone(),
        touched_tray_items: batch.touched_tray_items.clone(),
    }
}

fn construction_cycle_fingerprint(
    base: &Map<String, Value>,
    planet_id: &str,
    batch: &RepeatableBatch,
) -> ConstructionCycleFingerprint {
    let empty = Map::new();
    let planet_tray = tray(base, planet_id).unwrap_or(&empty);
    ConstructionCycleFingerprint {
        batch: batch_signature(batch),
        tray: batch
            .tray_returns
            .keys()
            .map(|item_id| (item_id.clone(), inventory_amount(planet_tray, item_id)))
            .collect(),
    }
}

fn construction_planning_base(base: &Map<String, Value>) -> Map<String, Value> {
    // A cycle probe must not duplicate the resident entity/belt domains. The
    // recursive planner and batch settlement only read or mutate these small
    // top-level construction fields.
    const KEYS: [&str; 10] = [
        "mode",
        "orbitalStation",
        "research",
        "activePlanetId",
        "tray",
        "planetTrays",
        "planetTrayItemLimits",
        "construction",
        "portableFleet",
        "totalProduced",
    ];
    KEYS.into_iter()
        .filter_map(|key| base.get(key).cloned().map(|value| (key.to_owned(), value)))
        .collect()
}

fn active_target_count(
    state: &CoreState,
    base: &Map<String, Value>,
    automation: &Map<String, Value>,
    jobs: &Map<String, Value>,
) -> usize {
    let Some(target_stock) = automation.get("targetStock").and_then(Value::as_object) else {
        return 0;
    };
    crate::construction_planner::targets(state)
        .iter()
        .filter(|target| {
            crate::construction_planner::target_is_unlocked(base, target)
                && floor_amount(finite_number(target_stock.get(&target.id)))
                    > current_stock(base, &target.id)
                        + pending_stock_in_jobs(state, jobs, &target.id)
        })
        .count()
}

fn batch_can_repeat(base: &Map<String, Value>, planet_id: &str, batch: &RepeatableBatch) -> bool {
    let empty = Map::new();
    let planet_tray = tray(base, planet_id).unwrap_or(&empty);
    let limit = tray_limit(base, planet_id);
    batch.tray_returns.iter().all(|(item_id, amount)| {
        let returned = floor_amount(*amount);
        if returned < 1.0 {
            return true;
        }
        let cost = floor_amount(batch.tray_costs.get(item_id).copied().unwrap_or(0.0));
        if cost > 0.0 {
            let current = inventory_amount(planet_tray, item_id);
            if current > limit {
                return false;
            }
            // A relevant return is the next cycle's working capital. If the
            // first return would overflow, the destroyed portion cannot be
            // reused and arithmetic batching would underpay a later cycle.
            let free_after_prefix = (limit - (current - cost).max(0.0)).max(0.0);
            if returned <= cost && returned > free_after_prefix {
                return false;
            }
        }
        !batch.relevant_items.contains(item_id) || returned <= cost
    }) && batch
        .fleet_returns
        .values()
        .all(|amount| floor_amount(*amount) < 1.0)
}

fn batch_maximum_cycles_for_stock(
    base: &Map<String, Value>,
    planet_id: &str,
    batch: &RepeatableBatch,
    quantum: &Map<String, Value>,
) -> f64 {
    let empty = Map::new();
    let planet_tray = tray(base, planet_id).unwrap_or(&empty);
    let mut maximum = MAX_SAFE_INTEGER;
    for (item_id, raw_cost) in &batch.tray_costs {
        let cost = floor_amount(*raw_cost);
        if cost < 1.0 {
            continue;
        }
        let returned = floor_amount(batch.tray_returns.get(item_id).copied().unwrap_or(0.0));
        let available = floor_amount(
            inventory_amount(planet_tray, item_id) + inventory_amount(quantum, item_id),
        );
        if available < cost {
            return 0.0;
        }
        // The first cycle needs the complete principal. Each later cycle can
        // immediately reuse its prior return and pays only the net loss.
        let net_cost = (cost - returned).max(0.0);
        if net_cost < 1.0 {
            continue;
        }
        maximum = maximum.min(1.0 + ((available - cost) / net_cost).floor());
    }
    maximum
}

fn construction_cycle_state_matches(
    base: &Map<String, Value>,
    planet_id: &str,
    batch: &RepeatableBatch,
) -> bool {
    if batch.jobs_per_cycle <= 1 {
        return true;
    }
    let empty = Map::new();
    let planet_tray = tray(base, planet_id).unwrap_or(&empty);
    batch.cycle_state_items.iter().all(|item_id| {
        inventory_amount(planet_tray, item_id)
            == floor_amount(
                batch
                    .cycle_start_inventory
                    .get(item_id)
                    .copied()
                    .unwrap_or(0.0),
            )
    })
}

#[allow(clippy::too_many_arguments)]
fn try_build_stable_cycle(
    state: &CoreState,
    base: &Map<String, Value>,
    automation: &Map<String, Value>,
    buffers: &Map<String, Value>,
    entity_id: &str,
    planet_id: &str,
    target: &crate::construction_planner::Target,
    first: &RepeatableBatch,
    remaining_plan_builds: &mut usize,
) -> anyhow::Result<Option<RepeatableBatch>> {
    const MAX_PROBE_JOBS: usize = 8;
    if first.jobs_per_cycle != 1 || *remaining_plan_builds < 1 {
        return Ok(None);
    }

    let mut planning_base = construction_planning_base(base);
    let mut planning_automation = automation.clone();
    let mut planning_buffers = Map::new();
    if let Some(buffer) = buffers.get(entity_id).cloned() {
        planning_buffers.insert(entity_id.to_owned(), buffer);
    }
    let destroyed_before = planning_automation.get("destroyedByproducts").cloned();
    let initial_fingerprint = construction_cycle_fingerprint(&planning_base, planet_id, first);
    let mut current = first.clone();
    let mut cycle = first.clone();
    let mut cycle_state_items = BTreeSet::<String>::new();

    for _ in 0..MAX_PROBE_JOBS {
        cycle_state_items.extend(current.tray_returns.keys().cloned());
        let completed = match apply_repeatable_batch(
            &mut planning_base,
            &mut planning_automation,
            &mut planning_buffers,
            entity_id,
            planet_id,
            target,
            &current,
            1.0,
        ) {
            Ok(completed) => completed,
            // A speculative phase proof is never authority. Any unexpected
            // probe-only mismatch falls back to the ordinary atomic job path.
            Err(_) => return Ok(None),
        };
        if completed < 1.0
            || planning_automation.get("destroyedByproducts") != destroyed_before.as_ref()
        {
            return Ok(None);
        }

        let empty = Map::new();
        let planet_tray = tray(&planning_base, planet_id).unwrap_or(&empty);
        let quantum = planning_buffers
            .get(entity_id)
            .and_then(Value::as_object)
            .unwrap_or(&empty);
        let inventory = crate::construction_planner::inventory_from_sources(planet_tray, quantum);
        if *remaining_plan_builds < 1 {
            return Ok(None);
        }
        *remaining_plan_builds -= 1;
        let Some(next_plan) =
            crate::construction_planner::build_plan(state, &planning_base, target, inventory)
        else {
            return Ok(None);
        };
        let Some(next) = analyze_repeatable_plan(state, &planning_base, target, &next_plan)? else {
            return Ok(None);
        };
        cycle_state_items.extend(next.tray_returns.keys().cloned());
        if construction_cycle_fingerprint(&planning_base, planet_id, &next) == initial_fingerprint {
            if !batch_can_repeat(base, planet_id, &cycle) {
                return Ok(None);
            }
            cycle.cycle_state_items = cycle_state_items.into_iter().collect();
            let initial_tray = tray(base, planet_id).unwrap_or(&empty);
            cycle.cycle_start_inventory = cycle
                .cycle_state_items
                .iter()
                .map(|item_id| (item_id.clone(), inventory_amount(initial_tray, item_id)))
                .collect();
            return Ok(Some(cycle));
        }
        cycle = compose_repeatable_batches(&cycle, &next);
        current = next;
    }
    Ok(None)
}

fn direct_cached_plan_is_valid(
    base: &Map<String, Value>,
    buffers: &Map<String, Value>,
    entity_id: &str,
    planet_id: &str,
    resolved: &ResolvedConstructionPlan,
) -> bool {
    let Some(batch) = resolved.batch.as_ref() else {
        return false;
    };
    let empty = Map::new();
    let quantum = buffers
        .get(entity_id)
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    batch_maximum_cycles_for_stock(base, planet_id, batch, quantum) >= 1.0
        && (batch.jobs_per_cycle <= 1 || construction_cycle_state_matches(base, planet_id, batch))
}

fn take_valid_direct_cached_plan(
    cache: &mut HashMap<String, ResolvedConstructionPlan>,
    target_id: &str,
    base: &Map<String, Value>,
    buffers: &Map<String, Value>,
    entity_id: &str,
    planet_id: &str,
) -> Option<ResolvedConstructionPlan> {
    if let Some(resolved) = cache.get(target_id)
        && direct_cached_plan_is_valid(base, buffers, entity_id, planet_id, resolved)
    {
        return Some(resolved.clone());
    }
    cache.remove(target_id);
    None
}

#[allow(clippy::too_many_arguments)]
fn build_resolved_construction_plan(
    state: &CoreState,
    base: &Map<String, Value>,
    automation: &Map<String, Value>,
    jobs: &Map<String, Value>,
    buffers: &Map<String, Value>,
    entity_id: &str,
    planet_id: &str,
    target: &crate::construction_planner::Target,
    remaining_plan_builds: &mut usize,
) -> anyhow::Result<Option<ResolvedConstructionPlan>> {
    if *remaining_plan_builds < 1 {
        return Ok(None);
    }
    *remaining_plan_builds -= 1;
    let empty = Map::new();
    let planet_tray = tray(base, planet_id)
        .ok_or_else(|| anyhow!("native construction planet tray is missing"))?;
    let quantum = buffers
        .get(entity_id)
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    let inventory = crate::construction_planner::inventory_from_sources(planet_tray, quantum);
    let Some(plan) = crate::construction_planner::build_plan(state, base, target, inventory) else {
        return Ok(None);
    };
    let mut batch = analyze_repeatable_plan(state, base, target, &plan)?;
    if let Some(base_batch) = batch.clone()
        && !batch_can_repeat(base, planet_id, &base_batch)
        && active_target_count(state, base, automation, jobs) == 1
    {
        batch = try_build_stable_cycle(
            state,
            base,
            automation,
            buffers,
            entity_id,
            planet_id,
            target,
            &base_batch,
            remaining_plan_builds,
        )?
        .or(Some(base_batch));
    }
    Ok(Some(ResolvedConstructionPlan { plan, batch }))
}

fn consume_combined_item(
    base: &mut Map<String, Value>,
    quantum: &mut Map<String, Value>,
    planet_id: &str,
    item_id: &str,
    raw_amount: f64,
    raw_tray_floor: f64,
    direct: bool,
) -> anyhow::Result<bool> {
    let mut remaining = floor_amount(raw_amount);
    let tray_floor = floor_amount(raw_tray_floor);
    {
        let planet_tray = tray_mut(base, planet_id)
            .ok_or_else(|| anyhow!("native construction planet tray is missing"))?;
        let current = inventory_amount(planet_tray, item_id);
        let from_tray = remaining.min((current - tray_floor).max(0.0));
        set_inventory_amount(planet_tray, item_id, current - from_tray)?;
        remaining -= from_tray;
    }
    if direct && remaining > 0.0 {
        let current = inventory_amount(quantum, item_id);
        let from_quantum = remaining.min(current);
        let next = current - from_quantum;
        if next < 1.0 {
            quantum.remove(item_id);
        } else {
            set_inventory_amount(quantum, item_id, next)?;
        }
        remaining -= from_quantum;
    }
    Ok(remaining < 1.0)
}

fn store_tray_return(
    base: &mut Map<String, Value>,
    automation: &mut Map<String, Value>,
    planet_id: &str,
    item_id: &str,
    raw_amount: f64,
) -> anyhow::Result<()> {
    let returned = floor_amount(raw_amount);
    if returned < 1.0 {
        return Ok(());
    }
    let limit = tray_limit(base, planet_id);
    let destroyed = {
        let planet_tray = tray_mut(base, planet_id)
            .ok_or_else(|| anyhow!("native construction planet tray is missing"))?;
        let current = inventory_amount(planet_tray, item_id);
        let stored = returned.min((limit - current).max(0.0));
        if stored > 0.0 {
            set_inventory_amount(planet_tray, item_id, current + stored)?;
        }
        returned - stored
    };
    if destroyed > 0.0 {
        let byproducts = automation
            .get_mut("destroyedByproducts")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native construction destroyed-byproduct state is missing"))?;
        let current = inventory_amount(byproducts, item_id);
        set_inventory_amount(
            byproducts,
            item_id,
            floor_amount(current + destroyed).min(MAX_SAFE_INTEGER),
        )?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn apply_repeatable_batch(
    base: &mut Map<String, Value>,
    automation: &mut Map<String, Value>,
    buffers: &mut Map<String, Value>,
    entity_id: &str,
    planet_id: &str,
    target: &crate::construction_planner::Target,
    batch: &RepeatableBatch,
    cycles: f64,
) -> anyhow::Result<f64> {
    let cycles = floor_amount(cycles).max(1.0);
    let direct = automation
        .get("quantumSourceEnabled")
        .and_then(Value::as_bool)
        == Some(true)
        || buffers
            .get(entity_id)
            .and_then(Value::as_object)
            .is_some_and(|buffer| !buffer.is_empty());
    let empty = Map::new();
    let quantum_before = if direct {
        buffers
            .get(entity_id)
            .and_then(Value::as_object)
            .unwrap_or(&empty)
    } else {
        &empty
    };
    if batch_maximum_cycles_for_stock(base, planet_id, batch, quantum_before) < cycles {
        return Ok(0.0);
    }
    if batch.jobs_per_cycle > 1 && !construction_cycle_state_matches(base, planet_id, batch) {
        return Ok(0.0);
    }
    {
        let planet_tray = tray_mut(base, planet_id)
            .ok_or_else(|| anyhow!("native construction planet tray is missing"))?;
        for item_id in &batch.touched_tray_items {
            if !planet_tray.contains_key(item_id) {
                set_inventory_amount(planet_tray, item_id, 0.0)?;
            }
        }
    }
    let mut quantum = buffers
        .remove(entity_id)
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    let material_items = batch
        .tray_costs
        .keys()
        .chain(batch.tray_returns.keys())
        .cloned()
        .collect::<BTreeSet<_>>();
    for item_id in material_items {
        let cost = floor_amount(batch.tray_costs.get(&item_id).copied().unwrap_or(0.0));
        let returned = floor_amount(batch.tray_returns.get(&item_id).copied().unwrap_or(0.0));
        if cost < 1.0 {
            store_tray_return(
                base,
                automation,
                planet_id,
                &item_id,
                safe_multiply(returned, cycles),
            )?;
            continue;
        }
        if returned < 1.0 {
            if !consume_combined_item(
                base,
                &mut quantum,
                planet_id,
                &item_id,
                safe_multiply(cost, cycles),
                0.0,
                direct,
            )? {
                bail!("native construction arithmetic batch exceeded its material certificate");
            }
            continue;
        }

        // Replay the exact first prefix once, then retain its return as the
        // next cycle's working capital and aggregate only the tail net loss.
        if !consume_combined_item(base, &mut quantum, planet_id, &item_id, cost, 0.0, direct)? {
            bail!("native construction arithmetic batch exceeded its first-cycle principal");
        }
        store_tray_return(base, automation, planet_id, &item_id, returned)?;
        let tail_cycles = cycles - 1.0;
        if tail_cycles < 1.0 {
            continue;
        }
        if cost > returned {
            let current_tray = tray(base, planet_id)
                .map(|planet_tray| inventory_amount(planet_tray, &item_id))
                .unwrap_or(0.0);
            if !consume_combined_item(
                base,
                &mut quantum,
                planet_id,
                &item_id,
                safe_multiply(cost - returned, tail_cycles),
                returned.min(current_tray),
                direct,
            )? {
                bail!("native construction arithmetic batch exceeded its net material budget");
            }
        } else if returned > cost {
            store_tray_return(
                base,
                automation,
                planet_id,
                &item_id,
                safe_multiply(returned - cost, tail_cycles),
            )?;
        }
    }
    quantum.retain(|_, amount| floor_amount(finite_number(Some(amount))) > 0.0);
    if direct && !quantum.is_empty() {
        buffers.insert(entity_id.to_owned(), Value::Object(quantum));
    }
    if !batch.fleet_returns.is_empty() {
        let fleet = base
            .get_mut("portableFleet")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native portable fleet state is missing"))?;
        for (item_id, amount) in &batch.fleet_returns {
            let returned = safe_multiply(*amount, cycles);
            if returned > 0.0 {
                let current = inventory_amount(fleet, item_id);
                set_inventory_amount(fleet, item_id, current + returned)?;
            }
        }
    }
    {
        let produced = base
            .get_mut("totalProduced")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native total production record is missing"))?;
        for (item_id, amount) in &batch.produced_items {
            let current = inventory_amount(produced, item_id);
            set_inventory_amount(produced, item_id, current + safe_multiply(*amount, cycles))?;
        }
    }
    let completed = safe_multiply(
        target.output_amount,
        safe_multiply(cycles, batch.jobs_per_cycle.max(1) as f64),
    );
    if matches!(target.id.as_str(), "logistics_drone" | "logistics_vessel") {
        let fleet = base
            .get_mut("portableFleet")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native portable fleet state is missing"))?;
        let current = inventory_amount(fleet, &target.id);
        set_inventory_amount(fleet, &target.id, current + completed)?;
    } else {
        let construction = base
            .get_mut("construction")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native construction inventory is missing"))?;
        let current = inventory_amount(construction, &target.id);
        set_inventory_amount(construction, &target.id, current + completed)?;
    }
    set_number(
        automation,
        "totalCrafted",
        floor_amount(finite_number(automation.get("totalCrafted")) + completed),
    )?;
    automation.insert("lastCraftedId".to_owned(), Value::from(target.id.clone()));
    Ok(completed)
}

#[allow(clippy::too_many_arguments)]
fn try_run_repeatable_batch(
    state: &CoreState,
    base: &mut Map<String, Value>,
    automation: &mut Map<String, Value>,
    jobs: &Map<String, Value>,
    buffers: &mut Map<String, Value>,
    entity_id: &str,
    planet_id: &str,
    target: &crate::construction_planner::Target,
    batch: &RepeatableBatch,
    remaining_work: f64,
    machine_count: f64,
    max_fair_batch_jobs: f64,
) -> anyhow::Result<Option<(f64, f64)>> {
    if target.output_amount < 1.0 || batch.work_seconds <= EPSILON {
        return Ok(None);
    }
    let active_targets = active_target_count(state, base, automation, jobs).max(1);
    let target_stock = automation
        .get("targetStock")
        .and_then(Value::as_object)
        .map(|targets| floor_amount(finite_number(targets.get(&target.id))))
        .unwrap_or(0.0);
    let current = current_stock(base, &target.id) + pending_stock_in_jobs(state, jobs, &target.id);
    let jobs_for_target = ((target_stock - current).max(0.0) / target.output_amount).ceil();
    let jobs_for_work = ((remaining_work.max(0.0) + EPSILON) / batch.work_seconds).floor();
    if jobs_for_target < 1.0 || jobs_for_work < 1.0 {
        return Ok(None);
    }
    let direct = automation
        .get("quantumSourceEnabled")
        .and_then(Value::as_bool)
        == Some(true)
        || buffers
            .get(entity_id)
            .and_then(Value::as_object)
            .is_some_and(|buffer| !buffer.is_empty());
    let empty = Map::new();
    let quantum = if direct {
        buffers
            .get(entity_id)
            .and_then(Value::as_object)
            .unwrap_or(&empty)
    } else {
        &empty
    };
    let cycles_for_stock = batch_maximum_cycles_for_stock(base, planet_id, batch, quantum);
    if cycles_for_stock < 1.0 {
        return Ok(None);
    }
    let repeatable = batch_can_repeat(base, planet_id, batch);
    let can_repeat = active_targets == 1 && jobs.is_empty() && repeatable;
    let high_load = machine_count >= 10_000.0 || remaining_work > 256.0;
    let can_fair_batch = high_load && repeatable;
    let fair_share =
        max_fair_batch_jobs.min((jobs_for_work / active_targets as f64).ceil().max(1.0));
    let jobs_per_cycle = batch.jobs_per_cycle.max(1) as f64;
    if batch.jobs_per_cycle > 1 && !construction_cycle_state_matches(base, planet_id, batch) {
        return Ok(None);
    }
    let cycles_for_target = (jobs_for_target / jobs_per_cycle).floor();
    // Keep the same conservative work guard as the JavaScript oracle for a
    // proven multi-job cycle. It may leave a small amount of work unused, but
    // cannot over-credit a construction bucket.
    let cycles_for_work = (jobs_for_work / jobs_per_cycle).floor();
    let cycles = if can_repeat {
        cycles_for_target.min(cycles_for_work).min(cycles_for_stock)
    } else if can_fair_batch {
        cycles_for_target
            .min(cycles_for_work)
            .min(cycles_for_stock)
            .min((fair_share / jobs_per_cycle).floor())
    } else {
        1.0
    };
    if cycles < 1.0 {
        return Ok(None);
    }
    let completed = apply_repeatable_batch(
        base, automation, buffers, entity_id, planet_id, target, batch, cycles,
    )?;
    if completed < 1.0 {
        return Ok(None);
    }
    Ok(Some((batch.work_seconds * cycles, completed)))
}

pub(crate) fn has_deficit(state: &CoreState, base: &Map<String, Value>) -> bool {
    let Ok(automation) = automation(base) else {
        return false;
    };
    if automation.get("enabled").and_then(Value::as_bool) != Some(true) {
        return false;
    }
    if automation
        .get("jobs")
        .and_then(Value::as_object)
        .is_some_and(|jobs| !jobs.is_empty())
        || automation
            .get("quantumMaterialBuffer")
            .and_then(Value::as_object)
            .is_some_and(|buffers| !buffers.is_empty())
    {
        return true;
    }
    let target_stock = automation.get("targetStock").and_then(Value::as_object);
    crate::construction_planner::targets(state)
        .iter()
        .any(|target| {
            let desired = target_stock
                .map(|stock| floor_amount(finite_number(stock.get(&target.id))))
                .unwrap_or(0.0);
            desired > current_stock(base, &target.id)
                && crate::construction_planner::target_is_unlocked(base, target)
        })
}

fn requirements_available(
    job_inventory: &Map<String, Value>,
    tray: &Map<String, Value>,
    quantum: &Map<String, Value>,
    requirements: &[ItemAmount],
) -> bool {
    requirements.iter().all(|requirement| {
        let required = floor_amount(requirement.amount);
        inventory_amount(job_inventory, &requirement.item_id)
            + inventory_amount(tray, &requirement.item_id)
            + inventory_amount(quantum, &requirement.item_id)
            >= required
    })
}

fn consume_requirements(
    job_inventory: &mut Map<String, Value>,
    tray: &mut Map<String, Value>,
    quantum: &mut Map<String, Value>,
    requirements: &[ItemAmount],
) -> anyhow::Result<bool> {
    if !requirements_available(job_inventory, tray, quantum, requirements) {
        return Ok(false);
    }
    for requirement in requirements {
        let mut remaining = floor_amount(requirement.amount);
        let in_job = inventory_amount(job_inventory, &requirement.item_id);
        let from_job = remaining.min(in_job);
        set_inventory_amount(job_inventory, &requirement.item_id, in_job - from_job)?;
        remaining -= from_job;
        let in_tray = inventory_amount(tray, &requirement.item_id);
        let from_tray = remaining.min(in_tray);
        set_inventory_amount(tray, &requirement.item_id, in_tray - from_tray)?;
        remaining -= from_tray;
        let in_quantum = inventory_amount(quantum, &requirement.item_id);
        set_inventory_amount(quantum, &requirement.item_id, in_quantum - remaining)?;
    }
    Ok(true)
}

fn reserve_requirements(
    base: &mut Map<String, Value>,
    buffers: &mut Map<String, Value>,
    entity_id: &str,
    planet_id: &str,
    job: &mut Map<String, Value>,
    requirements: &[ItemAmount],
) -> anyhow::Result<RequirementReservation> {
    let mut inventory = job
        .get("inventory")
        .and_then(Value::as_object)
        .cloned()
        .ok_or_else(|| anyhow!("native construction job inventory is missing"))?;
    let mut planet_tray = tray(base, planet_id)
        .cloned()
        .ok_or_else(|| anyhow!("native construction planet tray is missing"))?;
    let mut quantum = buffers
        .get(entity_id)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut changed = false;
    for requirement in requirements {
        let required = floor_amount(requirement.amount);
        let already_reserved = required.min(inventory_amount(&inventory, &requirement.item_id));
        let mut remaining = required - already_reserved;
        let in_tray = inventory_amount(&planet_tray, &requirement.item_id);
        let from_tray = remaining.min(in_tray);
        set_inventory_amount(&mut planet_tray, &requirement.item_id, in_tray - from_tray)?;
        remaining -= from_tray;
        let in_quantum = inventory_amount(&quantum, &requirement.item_id);
        let from_quantum = remaining.min(in_quantum);
        set_inventory_amount(
            &mut quantum,
            &requirement.item_id,
            in_quantum - from_quantum,
        )?;
        remaining -= from_quantum;
        if remaining > 0.0 {
            return Ok(RequirementReservation {
                available: false,
                changed: false,
            });
        }
        changed |= from_tray > 0.0 || from_quantum > 0.0;
        let current = inventory_amount(&inventory, &requirement.item_id);
        set_inventory_amount(
            &mut inventory,
            &requirement.item_id,
            current + from_tray + from_quantum,
        )?;
    }
    *tray_mut(base, planet_id)
        .ok_or_else(|| anyhow!("native construction planet tray is missing"))? = planet_tray;
    job.insert("inventory".to_owned(), Value::Object(inventory));
    if quantum
        .values()
        .any(|amount| floor_amount(finite_number(Some(amount))) > 0.0)
    {
        buffers.insert(entity_id.to_owned(), Value::Object(quantum));
    } else {
        buffers.remove(entity_id);
    }
    Ok(RequirementReservation {
        available: true,
        changed,
    })
}

fn repair_job(
    state: &CoreState,
    base: &Map<String, Value>,
    buffers: &Map<String, Value>,
    entity_id: &str,
    planet_id: &str,
    job: &mut Map<String, Value>,
) -> anyhow::Result<bool> {
    let Some(construction_id) = string_at(job, "constructionId").map(str::to_owned) else {
        return Ok(false);
    };
    let Some(target) = crate::construction_planner::targets(state)
        .into_iter()
        .find(|target| target.id == construction_id)
    else {
        return Ok(false);
    };
    let empty = Map::new();
    let planet_tray = tray(base, planet_id).unwrap_or(&empty);
    let quantum = buffers
        .get(entity_id)
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    let mut inventory = crate::construction_planner::inventory_from_sources(planet_tray, quantum);
    if let Some(job_inventory) = job.get("inventory").and_then(Value::as_object) {
        for (item_id, amount) in job_inventory {
            let current = inventory.get(item_id).copied().unwrap_or(0.0);
            inventory.insert(
                item_id.clone(),
                floor_amount(current + finite_number(Some(amount))),
            );
        }
    }
    let Some(plan) = crate::construction_planner::build_plan(state, base, &target, inventory)
    else {
        return Ok(false);
    };
    if plan.steps.is_empty() {
        return Ok(false);
    }
    let replacement = planned_job_value(&target, plan)
        .as_object()
        .cloned()
        .ok_or_else(|| anyhow!("native repaired construction job is invalid"))?;
    let replacement_steps = replacement
        .get("steps")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| anyhow!("native repaired construction steps are invalid"))?;
    let replacement_decisions = replacement
        .get("recipeDecisions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let step_index = floor_amount(finite_number(job.get("stepIndex"))) as usize;
    let steps = job
        .get_mut("steps")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| anyhow!("native construction job steps are missing"))?;
    steps.truncate(step_index.min(steps.len()));
    steps.extend(replacement_steps);
    job.insert(
        "recipeDecisions".to_owned(),
        Value::Array(replacement_decisions),
    );
    set_number(job, "elapsedSeconds", 0.0)?;
    Ok(true)
}

fn normalize_quantum_buffers(buffers: &mut Map<String, Value>) {
    for value in buffers.values_mut() {
        if let Some(inventory) = value.as_object_mut() {
            inventory.retain(|_, amount| floor_amount(finite_number(Some(amount))) > 0.0);
        }
    }
    buffers.retain(|_, value| {
        value
            .as_object()
            .is_some_and(|inventory| !inventory.is_empty())
    });
}

fn safe_persisted_inventory_amount(value: Option<&Value>, label: &str) -> anyhow::Result<u64> {
    match value {
        None => Ok(0),
        Some(value) => value
            .as_u64()
            .filter(|amount| *amount <= MAX_SAFE_INTEGER as u64)
            .ok_or_else(|| anyhow!("native construction {label} is not a safe integer")),
    }
}

fn checked_refund_inventory_add(
    inventory: &mut Map<String, Value>,
    item_id: &str,
    amount: u64,
    label: &str,
) -> anyhow::Result<()> {
    let current = safe_persisted_inventory_amount(inventory.get(item_id), label)?;
    let next = current
        .checked_add(amount)
        .filter(|next| *next <= MAX_SAFE_INTEGER as u64)
        .ok_or_else(|| {
            anyhow!("native construction {label} refund exceeds the safe integer limit")
        })?;
    inventory.insert(item_id.to_owned(), Value::from(next));
    Ok(())
}

fn refund_tray_mut<'a>(
    base: &'a mut Map<String, Value>,
    planet_id: &str,
) -> anyhow::Result<&'a mut Map<String, Value>> {
    let active_planet_id = base
        .get("activePlanetId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("native construction active planet is missing"))?
        .to_owned();
    if active_planet_id == planet_id {
        return base
            .get_mut("tray")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native construction active planet tray is missing"));
    }
    let trays = base
        .get_mut("planetTrays")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native construction planet tray directory is missing"))?;
    let tray = trays
        .entry(planet_id.to_owned())
        .or_insert_with(|| Value::Object(Map::new()));
    tray.as_object_mut()
        .ok_or_else(|| anyhow!("native construction planet tray is invalid"))
}

fn refund_planet_id(
    state: &CoreState,
    base: &Map<String, Value>,
    entity_id: &str,
) -> anyhow::Result<String> {
    let active_planet_id = base
        .get("activePlanetId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("native construction active planet is missing"))?;
    let planet_id = match state.entity_index.get(entity_id).copied() {
        None => active_planet_id.to_owned(),
        Some(entity_index) => {
            let entity = state.parse_entity(entity_index)?;
            let entity = entity
                .as_object()
                .ok_or_else(|| anyhow!("native construction refund entity is invalid"))?;
            entity
                .get("planetId")
                .and_then(Value::as_str)
                .unwrap_or(active_planet_id)
                .to_owned()
        }
    };
    if !state
        .catalog
        .planets
        .iter()
        .any(|planet| planet.id == planet_id)
    {
        bail!("native construction refund planet is unknown")
    }
    Ok(planet_id)
}

fn validate_refund_inventory(
    state: &CoreState,
    inventory: &Map<String, Value>,
    label: &str,
) -> anyhow::Result<()> {
    for (item_id, amount) in inventory {
        if !state.catalog.items.contains_key(item_id) {
            bail!("native construction {label} item is unknown")
        }
        safe_persisted_inventory_amount(Some(amount), label)?;
    }
    Ok(())
}

fn prove_quantum_refund_order_independent(
    state: &CoreState,
    base: &Map<String, Value>,
    buffers: &Map<String, Value>,
) -> anyhow::Result<()> {
    let mut totals = BTreeMap::<String, BigUint>::new();
    let mut refund_planets = BTreeMap::<String, BTreeSet<String>>::new();
    for (entity_id, value) in buffers {
        let inventory = value
            .as_object()
            .ok_or_else(|| anyhow!("native construction quantum buffer is invalid"))?;
        validate_refund_inventory(state, inventory, "quantum buffer")?;
        let planet_id = refund_planet_id(state, base, entity_id)?;
        for (item_id, value) in inventory {
            let amount = safe_persisted_inventory_amount(Some(value), "quantum buffer")?;
            if amount == 0 {
                continue;
            }
            *totals.entry(item_id.clone()).or_default() += BigUint::from(amount);
            refund_planets
                .entry(item_id.clone())
                .or_default()
                .insert(planet_id.clone());
        }
    }
    for (item_id, total) in totals {
        let accepted = crate::quantum_logistics::preview_construction_refund_acceptance(
            base, &item_id, &total,
        )?;
        if !accepted.is_zero()
            && accepted < total
            && refund_planets
                .get(&item_id)
                .is_some_and(|planets| planets.len() > 1)
        {
            bail!(
                "native construction quantum refund order is ambiguous across planets for {item_id}"
            )
        }
    }
    Ok(())
}

fn refund_job_inventory(
    state: &CoreState,
    base: &mut Map<String, Value>,
    planet_id: &str,
    inventory: &Map<String, Value>,
) -> anyhow::Result<()> {
    validate_refund_inventory(state, inventory, "job inventory")?;
    for (item_id, value) in inventory {
        let amount = safe_persisted_inventory_amount(Some(value), "job inventory")?;
        if amount == 0 {
            continue;
        }
        if matches!(item_id.as_str(), "logistics_drone" | "logistics_vessel") {
            let fleet = base
                .get_mut("portableFleet")
                .and_then(Value::as_object_mut)
                .ok_or_else(|| anyhow!("native construction portable fleet is missing"))?;
            checked_refund_inventory_add(fleet, item_id, amount, "portable fleet")?;
        } else {
            let tray = refund_tray_mut(base, planet_id)?;
            checked_refund_inventory_add(tray, item_id, amount, "planet tray")?;
        }
    }
    Ok(())
}

fn refund_quantum_buffer(
    base: &mut Map<String, Value>,
    buffers: &mut Map<String, Value>,
    entity_id: &str,
    planet_id: &str,
) -> anyhow::Result<()> {
    let Some(inventory) = buffers
        .remove(entity_id)
        .and_then(|value| value.as_object().cloned())
    else {
        return Ok(());
    };
    for (item_id, value) in inventory {
        let amount = floor_amount(finite_number(Some(&value)));
        if amount < 1.0 {
            continue;
        }
        let requested = amount.min(u64::MAX as f64) as u64;
        let deposited =
            crate::quantum_logistics::deposit_construction_refund(base, &item_id, requested)?;
        let remainder = requested.saturating_sub(deposited);
        if remainder > 0 {
            let planet_tray = refund_tray_mut(base, planet_id)?;
            let raw_current = finite_number(planet_tray.get(&item_id));
            if !nonnegative_safe_integer(raw_current) {
                bail!("native construction quantum refund exceeds the safe integer limit")
            }
            let current = raw_current as u64;
            let next = current
                .checked_add(remainder)
                .filter(|next| *next <= MAX_SAFE_INTEGER as u64)
                .ok_or_else(|| {
                    anyhow!("native construction quantum refund exceeds the safe integer limit")
                })?;
            planet_tray.insert(item_id, Value::from(next));
        }
    }
    Ok(())
}

/// Apply the current v47 single-target construction policy. Lowering a target
/// to already-owned stock is a cancellation transaction: only matching jobs
/// are refunded, while every direct quantum reservation is returned exactly as
/// the JavaScript authority does. The caller owns `base`, so any late failure
/// discards the entire derived candidate without touching the live state.
pub(crate) fn apply_target_stock_policy(
    state: &CoreState,
    base: &mut Map<String, Value>,
    target_id: &str,
    normalized_target: u64,
) -> anyhow::Result<()> {
    let stock_directory = if matches!(target_id, "logistics_drone" | "logistics_vessel") {
        "portableFleet"
    } else {
        "construction"
    };
    let current_stock = base
        .get(stock_directory)
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native construction target stock directory is missing"))?;
    let current_stock =
        safe_persisted_inventory_amount(current_stock.get(target_id), "current target stock")?;

    if normalized_target <= current_stock {
        let automation = base
            .get("constructionAutomation")
            .and_then(Value::as_object)
            .ok_or_else(|| anyhow!("native construction automation state is missing"))?;
        match automation.get("quantumMaterialBuffer") {
            None => {}
            Some(Value::Object(buffers)) => {
                prove_quantum_refund_order_independent(state, base, buffers)?
            }
            Some(_) => bail!("native construction quantum buffer directory is invalid"),
        }
    }

    let mut automation = base
        .remove("constructionAutomation")
        .and_then(|value| value.as_object().cloned())
        .ok_or_else(|| anyhow!("native construction automation state is missing"))?;
    let mut target_stock = automation
        .remove("targetStock")
        .and_then(|value| value.as_object().cloned())
        .ok_or_else(|| anyhow!("native construction target stock policy is missing"))?;
    if normalized_target == 0 {
        target_stock.remove(target_id);
    } else {
        target_stock.insert(target_id.to_owned(), Value::from(normalized_target));
    }
    automation.insert("targetStock".to_owned(), Value::Object(target_stock));

    if normalized_target <= current_stock {
        let mut jobs = automation
            .remove("jobs")
            .and_then(|value| value.as_object().cloned())
            .ok_or_else(|| anyhow!("native construction jobs are missing"))?;
        let matching_job_ids = jobs
            .iter()
            .filter_map(|(entity_id, job)| {
                (job.as_object()
                    .and_then(|job| job.get("constructionId"))
                    .and_then(Value::as_str)
                    == Some(target_id))
                .then_some(entity_id.clone())
            })
            .collect::<Vec<_>>();
        for entity_id in matching_job_ids {
            let job = jobs
                .get(&entity_id)
                .and_then(Value::as_object)
                .ok_or_else(|| anyhow!("native construction matching job is invalid"))?;
            let inventory = job
                .get("inventory")
                .and_then(Value::as_object)
                .ok_or_else(|| anyhow!("native construction matching job inventory is missing"))?
                .clone();
            let planet_id = refund_planet_id(state, base, &entity_id)?;
            refund_job_inventory(state, base, &planet_id, &inventory)?;
            jobs.remove(&entity_id);
        }
        automation.insert("jobs".to_owned(), Value::Object(jobs));

        let mut buffers = match automation.remove("quantumMaterialBuffer") {
            None => Map::new(),
            Some(Value::Object(buffers)) => buffers,
            Some(_) => bail!("native construction quantum buffer directory is invalid"),
        };
        let buffered_entity_ids = buffers.keys().cloned().collect::<Vec<_>>();
        for entity_id in buffered_entity_ids {
            let inventory = buffers
                .get(&entity_id)
                .and_then(Value::as_object)
                .ok_or_else(|| anyhow!("native construction quantum buffer is invalid"))?;
            validate_refund_inventory(state, inventory, "quantum buffer")?;
            let planet_id = refund_planet_id(state, base, &entity_id)?;
            refund_quantum_buffer(base, &mut buffers, &entity_id, &planet_id)?;
        }
        normalize_quantum_buffers(&mut buffers);
        if !buffers.is_empty() {
            automation.insert("quantumMaterialBuffer".to_owned(), Value::Object(buffers));
        }
    }

    base.insert(
        "constructionAutomation".to_owned(),
        Value::Object(automation),
    );
    Ok(())
}

fn remaining_inventory_need(
    state: &CoreState,
    job: &Map<String, Value>,
    start_index: usize,
) -> anyhow::Result<BTreeMap<String, f64>> {
    let steps = job
        .get("steps")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("native construction job steps are missing"))?;
    let mut needed = BTreeMap::<String, f64>::new();
    for value in steps.iter().skip(start_index).rev() {
        let step = parse_step(value)?;
        for requirement in requirements(state, &step)? {
            let current = needed.get(&requirement.item_id).copied().unwrap_or(0.0);
            needed.insert(
                requirement.item_id,
                floor_amount(current + requirement.amount),
            );
        }
        if let Step::Material {
            recipe_id, batches, ..
        } = step
        {
            let recipe = state
                .catalog
                .recipes
                .get(&recipe_id)
                .ok_or_else(|| anyhow!("native construction material recipe is missing"))?;
            for output in &recipe.outputs {
                let current = needed.get(&output.item_id).copied().unwrap_or(0.0);
                needed.insert(
                    output.item_id.clone(),
                    floor_amount(current - output.amount * batches),
                );
            }
        }
    }
    Ok(needed)
}

fn tray_limit(base: &Map<String, Value>, planet_id: &str) -> f64 {
    base.get("planetTrayItemLimits")
        .and_then(Value::as_object)
        .and_then(|limits| limits.get(planet_id))
        .map(|value| {
            finite_number(Some(value))
                .floor()
                .clamp(1_000.0, 100_000_000.0)
        })
        .unwrap_or(1_000_000.0)
}

fn settle_excess(
    state: &CoreState,
    base: &mut Map<String, Value>,
    automation: &mut Map<String, Value>,
    planet_id: &str,
    job: &mut Map<String, Value>,
    next_step_index: usize,
) -> anyhow::Result<()> {
    let needed = remaining_inventory_need(state, job, next_step_index)?;
    let inventory = job
        .remove("inventory")
        .and_then(|value| value.as_object().cloned())
        .ok_or_else(|| anyhow!("native construction job inventory is missing"))?;
    let mut retained = Map::new();
    let mut fleet_returns = Vec::<(String, f64)>::new();
    let mut tray_returns = Vec::<(String, f64)>::new();
    for (item_id, value) in inventory {
        let amount = floor_amount(finite_number(Some(&value)));
        let keep = amount.min(
            needed
                .get(&item_id)
                .copied()
                .unwrap_or(0.0)
                .max(0.0)
                .floor(),
        );
        if keep > 0.0 {
            retained.insert(item_id.clone(), Value::from(keep));
        }
        let excess = amount - keep;
        if excess < 1.0 {
            continue;
        }
        if matches!(item_id.as_str(), "logistics_drone" | "logistics_vessel") {
            fleet_returns.push((item_id, excess));
        } else {
            tray_returns.push((item_id, excess));
        }
    }
    job.insert("inventory".to_owned(), Value::Object(retained));
    if !fleet_returns.is_empty() {
        let fleet = base
            .get_mut("portableFleet")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native portable fleet state is missing"))?;
        for (item_id, amount) in fleet_returns {
            let current = floor_amount(finite_number(fleet.get(&item_id)));
            set_inventory_amount(fleet, &item_id, current + amount)?;
        }
    }
    let limit = tray_limit(base, planet_id);
    let mut destroyed = Vec::<(String, f64)>::new();
    {
        let planet_tray = tray_mut(base, planet_id)
            .ok_or_else(|| anyhow!("native construction planet tray is missing"))?;
        for (item_id, amount) in tray_returns {
            let current = inventory_amount(planet_tray, &item_id);
            let stored = amount.min((limit - current).max(0.0));
            if stored > 0.0 {
                set_inventory_amount(planet_tray, &item_id, current + stored)?;
            }
            let lost = amount - stored;
            if lost > 0.0 {
                destroyed.push((item_id, lost));
            }
        }
    }
    if !destroyed.is_empty() {
        let byproducts = automation
            .get_mut("destroyedByproducts")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native construction destroyed-byproduct state is missing"))?;
        for (item_id, amount) in destroyed {
            let current = floor_amount(finite_number(byproducts.get(&item_id)));
            set_inventory_amount(
                byproducts,
                &item_id,
                (current + amount).min(MAX_SAFE_INTEGER),
            )?;
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn complete_step(
    state: &CoreState,
    base: &mut Map<String, Value>,
    automation: &mut Map<String, Value>,
    buffers: &mut Map<String, Value>,
    entity_id: &str,
    planet_id: &str,
    job: &mut Map<String, Value>,
    step: &Step,
) -> anyhow::Result<bool> {
    let requirements = requirements(state, step)?;
    let mut job_inventory = job
        .remove("inventory")
        .and_then(|value| value.as_object().cloned())
        .ok_or_else(|| anyhow!("native construction job inventory is missing"))?;
    let mut quantum = buffers
        .remove(entity_id)
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    let consumed = {
        let tray = tray_mut(base, planet_id)
            .ok_or_else(|| anyhow!("native construction planet tray is missing"))?;
        consume_requirements(&mut job_inventory, tray, &mut quantum, &requirements)?
    };
    if !consumed {
        job.insert("inventory".to_owned(), Value::Object(job_inventory));
        if !quantum.is_empty() {
            buffers.insert(entity_id.to_owned(), Value::Object(quantum));
        }
        return Ok(false);
    }
    match step {
        Step::Building { construction_id } => {
            let definition = state
                .catalog
                .constructions
                .get(construction_id)
                .ok_or_else(|| anyhow!("native construction definition is missing"))?;
            let construction = base
                .get_mut("construction")
                .and_then(Value::as_object_mut)
                .ok_or_else(|| anyhow!("native construction inventory is missing"))?;
            let current = floor_amount(finite_number(construction.get(construction_id)));
            set_inventory_amount(
                construction,
                construction_id,
                current + definition.output_amount,
            )?;
            let total = finite_number(automation.get("totalCrafted")) + definition.output_amount;
            set_number(automation, "totalCrafted", total)?;
            automation.insert(
                "lastCraftedId".to_owned(),
                Value::from(construction_id.clone()),
            );
            job.insert("inventory".to_owned(), Value::Object(job_inventory));
            if !quantum.is_empty() {
                buffers.insert(entity_id.to_owned(), Value::Object(quantum));
            }
            let step_count = job
                .get("steps")
                .and_then(Value::as_array)
                .map(Vec::len)
                .unwrap_or(0);
            settle_excess(state, base, automation, planet_id, job, step_count)?;
        }
        Step::Material {
            recipe_id, batches, ..
        } => {
            let recipe = state
                .catalog
                .recipes
                .get(recipe_id)
                .ok_or_else(|| anyhow!("native construction material recipe is missing"))?;
            for output in &recipe.outputs {
                let produced = floor_amount(output.amount * batches);
                let current = inventory_amount(&job_inventory, &output.item_id);
                set_inventory_amount(&mut job_inventory, &output.item_id, current + produced)?;
                let total_produced = base
                    .get_mut("totalProduced")
                    .and_then(Value::as_object_mut)
                    .ok_or_else(|| anyhow!("native total production record is missing"))?;
                let current_total =
                    floor_amount(finite_number(total_produced.get(&output.item_id)));
                set_inventory_amount(total_produced, &output.item_id, current_total + produced)?;
            }
            job.insert("inventory".to_owned(), Value::Object(job_inventory));
            if !quantum.is_empty() {
                buffers.insert(entity_id.to_owned(), Value::Object(quantum));
            }
            let next_step = floor_amount(finite_number(job.get("stepIndex"))) as usize + 1;
            settle_excess(state, base, automation, planet_id, job, next_step)?;
        }
        Step::Fleet { item_id, amount } => {
            let fleet = base
                .get_mut("portableFleet")
                .and_then(Value::as_object_mut)
                .ok_or_else(|| anyhow!("native portable fleet state is missing"))?;
            let current = floor_amount(finite_number(fleet.get(item_id)));
            set_inventory_amount(fleet, item_id, current + amount)?;
            let total = finite_number(automation.get("totalCrafted")) + amount;
            set_number(automation, "totalCrafted", total)?;
            automation.insert("lastCraftedId".to_owned(), Value::from(item_id.clone()));
            job.insert("inventory".to_owned(), Value::Object(job_inventory));
            if !quantum.is_empty() {
                buffers.insert(entity_id.to_owned(), Value::Object(quantum));
            }
        }
    }
    normalize_quantum_buffers(buffers);
    Ok(true)
}

pub(crate) fn run_centers(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entities: &mut [Value],
    seconds: f64,
    power_factors: &HashMap<usize, f64>,
    center_indices: &[usize],
    runtime: &mut ConstructionRuntime,
) -> anyhow::Result<ConstructionRunOutcome> {
    let (selected_center_indices, scan) =
        runtime.selected_rows(state, base, entities, power_factors, center_indices);
    let mut receipt = ConstructionRunReceipt::default();
    if selected_center_indices.is_empty() {
        runtime.record_run_receipt(state.revision, &receipt);
        return Ok(ConstructionRunOutcome {
            quantum_wake: ConstructionQuantumWake::default(),
            scan,
            receipt,
        });
    }
    let mut automation = base
        .remove("constructionAutomation")
        .and_then(|value| value.as_object().cloned())
        .ok_or_else(|| anyhow!("native construction automation state is missing"))?;
    let enabled = automation.get("enabled").and_then(Value::as_bool) == Some(true);
    let mut jobs = automation
        .remove("jobs")
        .and_then(|value| value.as_object().cloned())
        .ok_or_else(|| anyhow!("native construction jobs are missing"))?;
    let mut buffers = automation
        .remove("quantumMaterialBuffer")
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    let mut wake_centers = BTreeSet::new();
    let selected_center_indices = selected_center_indices.into_iter().collect::<HashSet<_>>();
    let mut centers_by_planet = vec![Vec::<usize>::new(); state.catalog.planets.len()];
    for &entity_index in center_indices {
        let planet_index = state
            .factory_topology
            .entity_planet_indices
            .get(entity_index)
            .copied()
            .unwrap_or(usize::MAX);
        let centers = centers_by_planet
            .get_mut(planet_index)
            .ok_or_else(|| anyhow!("native construction center planet topology is unknown"))?;
        centers.push(entity_index);
    }
    for planet_center_indices in centers_by_planet {
        if planet_center_indices.is_empty() {
            continue;
        }
        let active_target_count_for_budget = active_target_count(state, base, &automation, &jobs);
        let extended_budget = active_target_count_for_budget > 1
            && planet_center_indices.iter().any(|&entity_index| {
                entities
                    .get(entity_index)
                    .and_then(Value::as_object)
                    .map(|center| finite_number(center.get("machineCount")))
                    .unwrap_or(0.0)
                    >= CONSTRUCTION_EXTENDED_STACK_THRESHOLD
            });
        let max_iterations_per_second = if extended_budget {
            CONSTRUCTION_EXTENDED_MAX_ITERATIONS_PER_SECOND
        } else {
            CONSTRUCTION_MAX_ITERATIONS_PER_SECOND
        };
        let max_plan_builds_per_second = if extended_budget {
            CONSTRUCTION_EXTENDED_MAX_PLAN_BUILDS_PER_SECOND
        } else {
            CONSTRUCTION_MAX_PLAN_BUILDS_PER_SECOND
        };
        let max_fair_batch_jobs = if extended_budget {
            CONSTRUCTION_EXTENDED_MAX_FAIR_BATCH_JOBS
        } else {
            CONSTRUCTION_MAX_FAIR_BATCH_JOBS
        };
        let mut remaining_iteration_pool = (seconds.max(0.0) * max_iterations_per_second)
            .ceil()
            .max(1.0) as usize;
        let mut remaining_plan_build_pool = (seconds.max(0.0) * max_plan_builds_per_second)
            .ceil()
            .max(1.0) as usize;
        let center_count = planet_center_indices.len();
        for (center_position, &entity_index) in planet_center_indices.iter().enumerate() {
            let centers_remaining = center_count - center_position;
            let allocated_iterations = if remaining_iteration_pool == 0 {
                0
            } else {
                remaining_iteration_pool
                    .min(remaining_iteration_pool.div_ceil(centers_remaining).max(1))
            };
            let allocated_plan_builds = if remaining_plan_build_pool == 0 {
                0
            } else {
                remaining_plan_build_pool
                    .min(remaining_plan_build_pool.div_ceil(centers_remaining).max(1))
            };
            remaining_iteration_pool -= allocated_iterations;
            remaining_plan_build_pool -= allocated_plan_builds;
            let mut budget = ConstructionComputeBudget {
                remaining_iterations: allocated_iterations,
                remaining_plan_builds: allocated_plan_builds,
            };
            if !selected_center_indices.contains(&entity_index) {
                remaining_iteration_pool += budget.remaining_iterations;
                remaining_plan_build_pool += budget.remaining_plan_builds;
                continue;
            }
            if entity_index >= entities.len() {
                bail!("native construction center index is outside the entity table");
            }
            let snapshot = entities[entity_index]
                .as_object()
                .ok_or_else(|| anyhow!("native construction entity is invalid"))?
                .clone();
            if string_at(&snapshot, "buildingId") != Some("construction_center") {
                bail!("native construction center index is stale");
            }
            let entity_id = string_at(&snapshot, "id").unwrap_or_default().to_owned();
            let planet_id = string_at(&snapshot, "planetId")
                .unwrap_or_default()
                .to_owned();
            let power_factor_entity = runtime
                .power_factor_entity(entity_index)
                .unwrap_or(entity_index);
            let power_factor = power_factors
                .get(&power_factor_entity)
                .copied()
                .unwrap_or(0.0);
            let demand_was_power_blocked = snapshot
                .get("powerFactor")
                .and_then(Value::as_f64)
                .is_some_and(|factor| factor <= EPSILON);
            let center = entities[entity_index]
                .as_object_mut()
                .ok_or_else(|| anyhow!("native construction center is invalid"))?;
            if power_factors.contains_key(&power_factor_entity) {
                set_number(
                    center,
                    "powerFactor",
                    (power_factor * 10_000.0).round() / 10_000.0,
                )?;
            } else {
                center.remove("powerFactor");
            }
            let demand_is_power_blocked = center
                .get("powerFactor")
                .and_then(Value::as_f64)
                .is_some_and(|factor| factor <= EPSILON);
            if demand_was_power_blocked != demand_is_power_blocked {
                wake_centers.insert(entity_index);
            }
            if !enabled || power_factor <= EPSILON {
                set_number(center, "utilization", 0.0)?;
                set_number(center, "productionRate", 0.0)?;
                set_number(center, "progress", 0.0)?;
                runtime.finish_center(base, entity_index, false, false, false);
                remaining_iteration_pool += budget.remaining_iterations;
                remaining_plan_build_pool += budget.remaining_plan_builds;
                continue;
            }
            let mut job = jobs
                .remove(&entity_id)
                .and_then(|value| value.as_object().cloned());
            let mut wait_for_planet_inventory = false;
            let mut wait_for_planner_cursor = false;
            let machine_count = finite_number(center.get("machineCount")).max(1.0);
            let mut remaining_work = seconds.max(0.0) * machine_count * power_factor;
            let mut completed = 0.0;
            let mut worked = false;
            let mut plan_budget_exhausted = false;
            let mut direct_resolved_by_target = HashMap::<String, ResolvedConstructionPlan>::new();
            while remaining_work > EPSILON && budget.remaining_iterations > 0 {
                budget.remaining_iterations -= 1;
                if job.is_none() {
                    let Some(target) = select_target(state, base, &automation, &jobs) else {
                        let buffered = buffers
                            .get(&entity_id)
                            .and_then(Value::as_object)
                            .is_some_and(|inventory| !inventory.is_empty());
                        refund_quantum_buffer(base, &mut buffers, &entity_id, &planet_id)?;
                        if buffered {
                            wake_centers.insert(entity_index);
                        }
                        break;
                    };
                    let has_direct_buffer = buffers
                        .get(&entity_id)
                        .and_then(Value::as_object)
                        .is_some_and(|buffer| !buffer.is_empty());
                    let cached_direct = has_direct_buffer
                        .then(|| {
                            take_valid_direct_cached_plan(
                                &mut direct_resolved_by_target,
                                &target.id,
                                base,
                                &buffers,
                                &entity_id,
                                &planet_id,
                            )
                        })
                        .flatten();
                    let resolved = if let Some(cached) = cached_direct {
                        cached
                    } else {
                        if budget.remaining_plan_builds < 1 {
                            plan_budget_exhausted = true;
                            break;
                        }
                        let Some(resolved) = build_resolved_construction_plan(
                            state,
                            base,
                            &automation,
                            &jobs,
                            &buffers,
                            &entity_id,
                            &planet_id,
                            &target,
                            &mut budget.remaining_plan_builds,
                        )?
                        else {
                            wait_for_planet_inventory = true;
                            wait_for_planner_cursor = true;
                            break;
                        };
                        if has_direct_buffer
                            && resolved.batch.as_ref().is_some_and(|batch| {
                                batch.jobs_per_cycle > 1
                                    || batch_can_repeat(base, &planet_id, batch)
                            })
                        {
                            direct_resolved_by_target.insert(target.id.clone(), resolved.clone());
                        }
                        resolved
                    };
                    if resolved.plan.steps.is_empty() {
                        wait_for_planet_inventory = true;
                        wait_for_planner_cursor = true;
                        break;
                    }
                    let target_count = crate::construction_planner::targets(state).len().max(1);
                    set_number(
                        &mut automation,
                        "cursor",
                        ((target.index + 1) % target_count) as f64,
                    )?;
                    if let Some(batch) = resolved.batch.as_ref()
                        && let Some((used_work, batch_completed)) = try_run_repeatable_batch(
                            state,
                            base,
                            &mut automation,
                            &jobs,
                            &mut buffers,
                            &entity_id,
                            &planet_id,
                            &target,
                            batch,
                            remaining_work,
                            machine_count,
                            max_fair_batch_jobs,
                        )?
                    {
                        wake_centers.insert(entity_index);
                        remaining_work = (remaining_work - used_work).max(0.0);
                        completed += batch_completed;
                        receipt.record_completion(
                            (!matches!(target.id.as_str(), "logistics_drone" | "logistics_vessel"))
                                .then_some(target.id.as_str()),
                            batch_completed,
                        );
                        worked = true;
                        set_number(center, "progress", 0.0)?;
                        continue;
                    }
                    job = planned_job_value(&target, resolved.plan)
                        .as_object()
                        .cloned();
                    wake_centers.insert(entity_index);
                }
                let current_job = job
                    .as_mut()
                    .ok_or_else(|| anyhow!("native construction job could not be planned"))?;
                let steps = current_job
                    .get("steps")
                    .and_then(Value::as_array)
                    .cloned()
                    .ok_or_else(|| anyhow!("native construction job steps are missing"))?;
                let step_index = floor_amount(finite_number(current_job.get("stepIndex"))) as usize;
                let Some(step_value) = steps.get(step_index) else {
                    job = None;
                    wake_centers.insert(entity_index);
                    continue;
                };
                let step = parse_step(step_value)?;
                let requirements = requirements(state, &step)?;
                let inputs_available = {
                    let job_inventory = current_job
                        .get("inventory")
                        .and_then(Value::as_object)
                        .ok_or_else(|| anyhow!("native construction job inventory is missing"))?;
                    let empty_quantum = Map::new();
                    let quantum = buffers
                        .get(&entity_id)
                        .and_then(Value::as_object)
                        .unwrap_or(&empty_quantum);
                    let planet_tray = tray(base, &planet_id)
                        .ok_or_else(|| anyhow!("native construction planet tray is missing"))?;
                    requirements_available(job_inventory, planet_tray, quantum, &requirements)
                };
                if !inputs_available {
                    // This is the exact transition that creates a direct quantum
                    // demand for a previously sleeping center. Retained positive
                    // demands need no repeated global scan; the center remains in
                    // the active set until a later probe proves it quiescent.
                    wake_centers.insert(entity_index);
                    if repair_job(state, base, &buffers, &entity_id, &planet_id, current_job)? {
                        continue;
                    }
                    wait_for_planet_inventory = true;
                    break;
                }
                let reservation = reserve_requirements(
                    base,
                    &mut buffers,
                    &entity_id,
                    &planet_id,
                    current_job,
                    &requirements,
                )?;
                if !reservation.available {
                    wake_centers.insert(entity_index);
                    wait_for_planet_inventory = true;
                    break;
                }
                if reservation.changed {
                    wake_centers.insert(entity_index);
                }
                let duration = step_duration(state, base, &step)?;
                let elapsed = finite_number(current_job.get("elapsedSeconds"));
                let needed = (duration - elapsed).max(0.0);
                let used = remaining_work.min(needed);
                let next_elapsed = ((elapsed + used) * 1_000_000.0).round() / 1_000_000.0;
                set_number(current_job, "elapsedSeconds", next_elapsed)?;
                remaining_work -= used;
                worked |= used > EPSILON;
                set_number(
                    center,
                    "progress",
                    ((next_elapsed / duration).min(1.0) * 1_000_000.0).round() / 1_000_000.0,
                )?;
                if next_elapsed + EPSILON < duration {
                    break;
                }
                if !complete_step(
                    state,
                    base,
                    &mut automation,
                    &mut buffers,
                    &entity_id,
                    &planet_id,
                    current_job,
                    &step,
                )? {
                    wake_centers.insert(entity_index);
                    break;
                }
                wake_centers.insert(entity_index);
                if let Step::Building { construction_id } = &step {
                    let output_amount = state
                        .catalog
                        .constructions
                        .get(construction_id)
                        .map(|definition| definition.output_amount)
                        .unwrap_or(0.0);
                    completed += output_amount;
                    receipt.record_completion(Some(construction_id), output_amount);
                } else if let Step::Fleet { amount, .. } = &step {
                    completed += amount;
                    receipt.record_completion(None, *amount);
                }
                set_number(current_job, "stepIndex", step_index as f64 + 1.0)?;
                set_number(current_job, "elapsedSeconds", 0.0)?;
                set_number(center, "progress", 0.0)?;
                if step_index + 1 >= steps.len() {
                    job = None;
                }
            }
            set_number(
                center,
                "utilization",
                if worked || completed > 0.0 {
                    power_factor
                } else {
                    0.0
                },
            )?;
            set_number(
                center,
                "productionRate",
                if seconds > EPSILON {
                    (completed * 60.0 / seconds * 100.0).round() / 100.0
                } else {
                    0.0
                },
            )?;
            let final_job_target = job
                .as_ref()
                .and_then(|job| string_at(job, "constructionId"))
                .map(str::to_owned);
            let final_job_present = job.is_some();
            if let Some(job) = job {
                jobs.insert(entity_id.clone(), Value::Object(job));
            }
            runtime.update_job_target(entity_index, final_job_target.as_deref());
            let keep_active = worked
                || completed > 0.0
                || remaining_work > EPSILON
                    && (budget.remaining_iterations == 0 || plan_budget_exhausted)
                || (!wait_for_planet_inventory && final_job_present);
            runtime.finish_center(
                base,
                entity_index,
                keep_active,
                wait_for_planet_inventory,
                wait_for_planner_cursor,
            );
            remaining_iteration_pool += budget.remaining_iterations;
            remaining_plan_build_pool += budget.remaining_plan_builds;
        }
    }
    automation.insert("jobs".to_owned(), Value::Object(jobs));
    normalize_quantum_buffers(&mut buffers);
    if !buffers.is_empty() {
        automation.insert("quantumMaterialBuffer".to_owned(), Value::Object(buffers));
    }
    base.insert(
        "constructionAutomation".to_owned(),
        Value::Object(automation),
    );
    runtime.commit_dependencies(state, base);
    runtime.record_run_receipt(state.revision, &receipt);
    Ok(ConstructionRunOutcome {
        quantum_wake: ConstructionQuantumWake {
            center_indices: wake_centers.into_iter().collect(),
        },
        scan,
        receipt,
    })
}

fn plan_construction_center_probes<R, F>(
    runtime: &DeterministicRuntime,
    centers: &[&Map<String, Value>],
    probe: F,
) -> anyhow::Result<Vec<R>>
where
    R: Send,
    F: Fn(usize, &Map<String, Value>) -> anyhow::Result<R> + Send + Sync,
{
    runtime.indexed_try_map(centers, |index, center| probe(index, center))
}

#[allow(clippy::too_many_arguments)]
fn quantum_prefetch_jobs(
    state: &CoreState,
    base: &Map<String, Value>,
    automation: &Map<String, Value>,
    jobs: &Map<String, Value>,
    center: &Map<String, Value>,
    target: &crate::construction_planner::Target,
    work_seconds: f64,
    has_existing_job: bool,
    power_factor: f64,
) -> f64 {
    let target_stock = automation
        .get("targetStock")
        .and_then(Value::as_object)
        .map(|targets| floor_amount(finite_number(targets.get(&target.id))))
        .unwrap_or(0.0);
    let current = current_stock(base, &target.id) + pending_stock_in_jobs(state, jobs, &target.id);
    let target_jobs = ((target_stock - current).max(0.0) / target.output_amount.max(1.0)).ceil();
    let machine_count = floor_amount(finite_number(center.get("machineCount"))).max(1.0);
    let work_jobs =
        (machine_count * CONSTRUCTION_QUANTUM_PREFETCH_SECONDS * power_factor.clamp(0.0, 1.0)
            / work_seconds.max(EPSILON))
        .ceil()
        .max(1.0);
    let requested_jobs = (target_jobs + if has_existing_job { 1.0 } else { 0.0 }).max(1.0);
    let prefetch_limit = if machine_count >= CONSTRUCTION_EXTENDED_STACK_THRESHOLD {
        CONSTRUCTION_QUANTUM_EXTENDED_PREFETCH_MAX_JOBS
    } else {
        CONSTRUCTION_QUANTUM_PREFETCH_MAX_JOBS
    };
    prefetch_limit.min(requested_jobs.min(work_jobs).max(1.0))
}

#[allow(clippy::too_many_arguments)]
fn quantum_missing_for_batch(
    state: &CoreState,
    base: &Map<String, Value>,
    automation: &Map<String, Value>,
    jobs: &Map<String, Value>,
    center: &Map<String, Value>,
    target: &crate::construction_planner::Target,
    batch: &RepeatableBatch,
    planet_tray: &Map<String, Value>,
    job_inventory: &Map<String, Value>,
    quantum: &Map<String, Value>,
    has_existing_job: bool,
    power_factor: f64,
) -> BTreeMap<String, f64> {
    let jobs_to_prefetch = quantum_prefetch_jobs(
        state,
        base,
        automation,
        jobs,
        center,
        target,
        batch.work_seconds,
        has_existing_job,
        power_factor,
    );
    batch
        .tray_costs
        .iter()
        .filter(|(item_id, _)| !matches!(item_id.as_str(), "logistics_drone" | "logistics_vessel"))
        .filter_map(|(item_id, raw_amount)| {
            let required = safe_multiply(*raw_amount, jobs_to_prefetch);
            let available = safe_add(
                safe_add(
                    inventory_amount(planet_tray, item_id),
                    inventory_amount(job_inventory, item_id),
                ),
                inventory_amount(quantum, item_id),
            );
            let amount = (required - available).max(0.0);
            (amount > 0.0).then(|| (item_id.clone(), amount))
        })
        .collect()
}

fn remaining_job_plan(
    job: &Map<String, Value>,
    step_index: usize,
) -> anyhow::Result<crate::construction_planner::Plan> {
    let values = job
        .get("steps")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("native construction job steps are missing"))?;
    let steps = values
        .iter()
        .skip(step_index)
        .map(|value| {
            Ok(match parse_step(value)? {
                Step::Material {
                    recipe_id,
                    batches,
                    output_item_id,
                    output_amount,
                } => crate::construction_planner::PlannedStep::Material {
                    recipe_id,
                    batches,
                    output_item_id,
                    output_amount,
                },
                Step::Building { construction_id } => {
                    crate::construction_planner::PlannedStep::Building { construction_id }
                }
                Step::Fleet { item_id, amount } => {
                    crate::construction_planner::PlannedStep::Fleet { item_id, amount }
                }
            })
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    Ok(crate::construction_planner::Plan {
        steps,
        decisions: Vec::new(),
    })
}

fn no_job_quantum_missing_materials(
    state: &CoreState,
    base: &Map<String, Value>,
    automation: &Map<String, Value>,
    jobs: &Map<String, Value>,
    center: &Map<String, Value>,
) -> anyhow::Result<BTreeMap<String, f64>> {
    let Some(target) = select_target(state, base, automation, jobs) else {
        return Ok(BTreeMap::new());
    };
    let entity_id = string_at(center, "id").unwrap_or_default();
    let planet_id = string_at(center, "planetId").unwrap_or_default();
    let empty = Map::new();
    let planet_tray = tray(base, planet_id).unwrap_or(&empty);
    let quantum = quantum_buffer(automation, entity_id).unwrap_or(&empty);
    let mut virtual_quantum = quantum.clone();
    let mut seed_missing = BTreeMap::<String, f64>::new();
    let mut complete_plan = None;
    for _ in 0..128 {
        let inventory =
            crate::construction_planner::inventory_from_sources(planet_tray, &virtual_quantum);
        match crate::construction_planner::probe_plan(state, base, &target, inventory) {
            crate::construction_planner::PlanOutcome::Ready(plan) => {
                complete_plan = Some(plan);
                break;
            }
            crate::construction_planner::PlanOutcome::RawShortage {
                item_id,
                current,
                required,
            } if !matches!(item_id.as_str(), "logistics_drone" | "logistics_vessel") => {
                let amount = floor_amount((required - current).max(0.0));
                if amount < 1.0 {
                    break;
                }
                let accumulated = seed_missing.get(&item_id).copied().unwrap_or(0.0);
                seed_missing.insert(item_id.clone(), safe_add(accumulated, amount));
                let current_virtual = inventory_amount(&virtual_quantum, &item_id);
                set_inventory_amount(
                    &mut virtual_quantum,
                    &item_id,
                    safe_add(current_virtual, amount),
                )?;
            }
            crate::construction_planner::PlanOutcome::RawShortage { .. }
            | crate::construction_planner::PlanOutcome::Blocked => break,
        }
    }
    let Some(plan) = complete_plan else {
        return Ok(seed_missing);
    };
    let Some(batch) = analyze_repeatable_plan(state, base, &target, &plan)? else {
        return Ok(seed_missing);
    };
    let power_factor = center
        .get("powerFactor")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .unwrap_or(1.0)
        .clamp(0.0, 1.0);
    Ok(quantum_missing_for_batch(
        state,
        base,
        automation,
        jobs,
        center,
        &target,
        &batch,
        planet_tray,
        &empty,
        quantum,
        false,
        power_factor,
    ))
}

fn probe_quantum_demands(
    state: &CoreState,
    base: &Map<String, Value>,
    automation: &Map<String, Value>,
    jobs: &Map<String, Value>,
    entity_index: usize,
    active_row: Option<usize>,
    center: &Map<String, Value>,
) -> anyhow::Result<Vec<QuantumDemand>> {
    if center
        .get("powerFactor")
        .and_then(Value::as_f64)
        .is_some_and(|factor| factor <= EPSILON)
    {
        return Ok(Vec::new());
    }
    let entity_id = string_at(center, "id").unwrap_or_default();
    let planet_id = string_at(center, "planetId").unwrap_or_default();
    let missing = if let Some(job) = jobs.get(entity_id).and_then(Value::as_object) {
        let step_index = floor_amount(finite_number(job.get("stepIndex"))) as usize;
        let Some(step) = job
            .get("steps")
            .and_then(Value::as_array)
            .and_then(|steps| steps.get(step_index))
        else {
            return Ok(Vec::new());
        };
        let step = parse_step(step)?;
        let job_inventory = job
            .get("inventory")
            .and_then(Value::as_object)
            .ok_or_else(|| anyhow!("native construction job inventory is missing"))?;
        let empty = Map::new();
        let planet_tray = tray(base, planet_id).unwrap_or(&empty);
        let quantum = quantum_buffer(automation, entity_id).unwrap_or(&empty);
        let power_factor = center
            .get("powerFactor")
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite())
            .unwrap_or(1.0)
            .clamp(0.0, 1.0);
        if let Some(target) = string_at(job, "constructionId").and_then(|construction_id| {
            crate::construction_planner::targets(state)
                .into_iter()
                .find(|target| target.id == construction_id)
        }) {
            let remaining_plan = remaining_job_plan(job, step_index)?;
            if let Some(batch) = analyze_repeatable_plan(state, base, &target, &remaining_plan)? {
                return Ok(quantum_missing_for_batch(
                    state,
                    base,
                    automation,
                    jobs,
                    center,
                    &target,
                    &batch,
                    planet_tray,
                    job_inventory,
                    quantum,
                    true,
                    power_factor,
                )
                .into_iter()
                .filter_map(|(item_id, amount)| {
                    let amount = floor_amount(amount) as u64;
                    (amount > 0).then(|| QuantumDemand {
                        key: format!("construction-direct:{entity_id}:{item_id}"),
                        entity_index,
                        active_row,
                        entity_id: entity_id.to_owned(),
                        item_id,
                        amount,
                    })
                })
                .collect());
            }
        }
        let mut missing = BTreeMap::<String, f64>::new();
        for requirement in requirements_from_catalog(state.catalog.as_ref(), &step)? {
            if matches!(
                requirement.item_id.as_str(),
                "logistics_drone" | "logistics_vessel"
            ) {
                continue;
            }
            let required = floor_amount(requirement.amount);
            let available = inventory_amount(job_inventory, &requirement.item_id)
                + inventory_amount(planet_tray, &requirement.item_id)
                + inventory_amount(quantum, &requirement.item_id);
            let amount = (required - available).max(0.0);
            if amount > 0.0 {
                *missing.entry(requirement.item_id).or_default() += amount;
            }
        }
        missing
    } else {
        no_job_quantum_missing_materials(state, base, automation, jobs, center)?
    };
    Ok(missing
        .into_iter()
        .filter_map(|(item_id, amount)| {
            let amount = floor_amount(amount) as u64;
            (amount > 0).then(|| QuantumDemand {
                key: format!("construction-direct:{entity_id}:{item_id}"),
                entity_index,
                active_row,
                entity_id: entity_id.to_owned(),
                item_id,
                amount,
            })
        })
        .collect())
}

fn collect_quantum_demands_with_runtime(
    runtime: &DeterministicRuntime,
    state: &CoreState,
    base: &Map<String, Value>,
    automation: &Map<String, Value>,
    jobs: &Map<String, Value>,
    entities: &[Value],
) -> anyhow::Result<Vec<QuantumDemand>> {
    let mut indexed_centers = entities
        .iter()
        .enumerate()
        .filter_map(|(entity_index, value)| value.as_object().map(|center| (entity_index, center)))
        .filter(|(_, entity)| string_at(entity, "buildingId") == Some("construction_center"))
        .collect::<Vec<_>>();
    indexed_centers.sort_by(|(_, left), (_, right)| {
        string_at(left, "id")
            .unwrap_or_default()
            .cmp(string_at(right, "id").unwrap_or_default())
    });
    let centers = indexed_centers
        .iter()
        .map(|(_, center)| *center)
        .collect::<Vec<_>>();
    // A center probe only reads its saved job and the immutable inventory
    // snapshot. The later quantum-logistics replay still allocates the shared
    // stock in this exact ID order, so worker scheduling cannot change which
    // center wins a scarce item.
    let planned = plan_construction_center_probes(runtime, &centers, |index, center| {
        probe_quantum_demands(
            state,
            base,
            automation,
            jobs,
            indexed_centers[index].0,
            None,
            center,
        )
    })?;
    let demand_count = planned.iter().map(Vec::len).sum();
    let mut result = Vec::with_capacity(demand_count);
    for demands in planned {
        result.extend(demands);
    }
    Ok(result)
}

struct QuantumDemandProbeInputs<'a> {
    state: &'a CoreState,
    base: &'a Map<String, Value>,
    automation: &'a Map<String, Value>,
    jobs: &'a Map<String, Value>,
}

fn collect_quantum_demands_for_center_indices_with_runtime(
    runtime: &DeterministicRuntime,
    inputs: &QuantumDemandProbeInputs<'_>,
    entities: &[Value],
    center_indices: &[usize],
    active_rows: &[usize],
) -> anyhow::Result<Vec<QuantumDemand>> {
    if active_rows.len() != center_indices.len() {
        bail!("native construction quantum active row directory is stale");
    }
    let centers = center_indices
        .iter()
        .map(|&entity_index| {
            entities
                .get(entity_index)
                .and_then(Value::as_object)
                .filter(|entity| string_at(entity, "buildingId") == Some("construction_center"))
                .ok_or_else(|| anyhow!("native construction center index is stale"))
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    let planned = plan_construction_center_probes(runtime, &centers, |index, center| {
        probe_quantum_demands(
            inputs.state,
            inputs.base,
            inputs.automation,
            inputs.jobs,
            center_indices[index],
            Some(active_rows[index]),
            center,
        )
    })?;
    let demand_count = planned.iter().map(Vec::len).sum();
    let mut result = Vec::with_capacity(demand_count);
    for demands in planned {
        result.extend(demands);
    }
    Ok(result)
}

pub(crate) fn quantum_demands_for_center_indices(
    state: &CoreState,
    base: &Map<String, Value>,
    entities: &[Value],
    center_indices: &[usize],
    active_rows: &[usize],
) -> anyhow::Result<Vec<QuantumDemand>> {
    let automation = automation(base)?;
    if automation.get("enabled").and_then(Value::as_bool) != Some(true)
        || automation
            .get("quantumSourceEnabled")
            .and_then(Value::as_bool)
            != Some(true)
    {
        return Ok(Vec::new());
    }
    let jobs = automation
        .get("jobs")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native construction jobs are missing"))?;
    collect_quantum_demands_for_center_indices_with_runtime(
        deterministic_runtime(),
        &QuantumDemandProbeInputs {
            state,
            base,
            automation,
            jobs,
        },
        entities,
        center_indices,
        active_rows,
    )
}

pub(crate) fn quantum_demands(
    state: &CoreState,
    base: &Map<String, Value>,
    entities: &[Value],
) -> anyhow::Result<Vec<QuantumDemand>> {
    let automation = automation(base)?;
    if automation.get("enabled").and_then(Value::as_bool) != Some(true)
        || automation
            .get("quantumSourceEnabled")
            .and_then(Value::as_bool)
            != Some(true)
    {
        return Ok(Vec::new());
    }
    let jobs = automation
        .get("jobs")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native construction jobs are missing"))?;
    collect_quantum_demands_with_runtime(
        deterministic_runtime(),
        state,
        base,
        automation,
        jobs,
        entities,
    )
}

pub(crate) fn apply_quantum_delivery(
    base: &mut Map<String, Value>,
    demand: &QuantumDemand,
    delivered: u64,
) -> anyhow::Result<u64> {
    let amount = delivered.min(demand.amount);
    if amount < 1 {
        return Ok(0);
    }
    let automation = base
        .get_mut("constructionAutomation")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native construction automation state is missing"))?;
    if !automation.contains_key("quantumMaterialBuffer") {
        automation.insert(
            "quantumMaterialBuffer".to_owned(),
            Value::Object(Map::new()),
        );
    }
    let buffers = automation
        .get_mut("quantumMaterialBuffer")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native construction quantum buffers are invalid"))?;
    if !buffers.contains_key(&demand.entity_id) {
        buffers.insert(demand.entity_id.clone(), Value::Object(Map::new()));
    }
    let inventory = buffers
        .get_mut(&demand.entity_id)
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native construction quantum buffer is invalid"))?;
    let current = inventory_amount(inventory, &demand.item_id);
    set_inventory_amount(inventory, &demand.item_id, current + amount as f64)?;
    Ok(amount)
}

pub(crate) fn is_operating_blocked(
    state: &CoreState,
    base: &Map<String, Value>,
    entity: &Map<String, Value>,
) -> anyhow::Result<bool> {
    let automation = automation(base)?;
    if automation.get("enabled").and_then(Value::as_bool) != Some(true) || !has_deficit(state, base)
    {
        return Ok(false);
    }
    if finite_number(entity.get("powerFactor")) <= EPSILON {
        return Ok(true);
    }
    let entity_id = string_at(entity, "id").unwrap_or_default();
    let planet_id = string_at(entity, "planetId").unwrap_or_default();
    let jobs = automation
        .get("jobs")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native construction jobs are missing"))?;
    let Some(job) = jobs.get(entity_id).and_then(Value::as_object) else {
        // The JavaScript status path still tries to plan the next globally
        // deficient target for an idle center. A missing plan means that the
        // center is visibly blocked even though no persisted job exists yet.
        let Some(target) = select_target(state, base, automation, jobs) else {
            return Ok(false);
        };
        let empty = Map::new();
        let planet_tray = tray(base, planet_id).unwrap_or(&empty);
        let quantum = quantum_buffer(automation, entity_id).unwrap_or(&empty);
        let inventory = crate::construction_planner::inventory_from_sources(planet_tray, quantum);
        return Ok(
            crate::construction_planner::build_plan(state, base, &target, inventory).is_none(),
        );
    };
    let step_index = floor_amount(finite_number(job.get("stepIndex"))) as usize;
    let Some(step) = job
        .get("steps")
        .and_then(Value::as_array)
        .and_then(|steps| steps.get(step_index))
    else {
        return Ok(true);
    };
    let step = parse_step(step)?;
    let requirements = requirements(state, &step)?;
    let empty = Map::new();
    let inventory = job
        .get("inventory")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    let planet_tray = tray(base, planet_id).unwrap_or(&empty);
    let quantum = quantum_buffer(automation, entity_id).unwrap_or(&empty);
    Ok(!requirements_available(
        inventory,
        planet_tray,
        quantum,
        &requirements,
    ))
}

pub(crate) fn admission_reason(state: &CoreState) -> anyhow::Result<Option<&'static str>> {
    let base = state.base_value();
    let automation = automation(base)?;
    let jobs = automation
        .get("jobs")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native construction jobs are missing"))?;
    let entity_ids = (0..state.entity_index.len())
        .filter(|&index| {
            state.symbols.resolve(state.entities.buildings[index]) == Some("construction_center")
        })
        .map(|index| state.entities.ids[index].to_string())
        .collect::<std::collections::HashSet<_>>();
    let buffers = automation
        .get("quantumMaterialBuffer")
        .and_then(Value::as_object);
    if buffers.is_some_and(|buffers| {
        buffers.iter().any(|(entity_id, inventory)| {
            !entity_ids.contains(entity_id)
                || inventory.as_object().is_none_or(|inventory| {
                    inventory
                        .values()
                        .any(|amount| floor_amount(finite_number(Some(amount))) < 1.0)
                })
        })
    }) {
        return Ok(Some("construction-quantum-buffer-unsupported"));
    }
    if all_centers_provably_unpowered(state)? {
        if jobs
            .iter()
            .any(|(entity_id, job)| !entity_ids.contains(entity_id) || job.as_object().is_none())
        {
            return Ok(Some("construction-job-invalid"));
        }
        return Ok(None);
    }
    for (entity_id, job) in jobs {
        if !entity_ids.contains(entity_id) {
            return Ok(Some("construction-job-center-missing"));
        }
        let Some(job) = job.as_object() else {
            return Ok(Some("construction-job-invalid"));
        };
        let Some(construction_id) = string_at(job, "constructionId") else {
            return Ok(Some("construction-job-invalid"));
        };
        if !state.catalog.constructions.contains_key(construction_id)
            && !matches!(construction_id, "logistics_drone" | "logistics_vessel")
            || job.get("inventory").and_then(Value::as_object).is_none()
        {
            return Ok(Some("construction-job-invalid"));
        }
        let Some(steps) = job.get("steps").and_then(Value::as_array) else {
            return Ok(Some("construction-job-invalid"));
        };
        let step_index = floor_amount(finite_number(job.get("stepIndex"))) as usize;
        if steps.is_empty() || steps.get(step_index).is_none() {
            return Ok(Some("construction-job-invalid"));
        }
        for value in steps {
            let step = match parse_step(value) {
                Ok(step) => step,
                Err(_) => return Ok(Some("construction-step-invalid")),
            };
            if requirements(state, &step).is_err()
                || matches!(&step, Step::Fleet { item_id, amount }
                    if !matches!(item_id.as_str(), "logistics_drone" | "logistics_vessel") || *amount < 1.0)
            {
                return Ok(Some("construction-step-invalid"));
            }
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::{
        BuildingDefinition, CatalogSnapshot, ConstructionDefinition, ItemDefinition,
        PlanetDefinition,
    };
    use crate::construction_planner::TargetKind;
    use serde_json::json;
    use std::sync::Arc;

    fn object(value: Value) -> Map<String, Value> {
        value.as_object().expect("test object").clone()
    }

    fn batch(
        costs: &[(&str, f64)],
        returns: &[(&str, f64)],
        produced: &[(&str, f64)],
    ) -> RepeatableBatch {
        let tray_costs = costs
            .iter()
            .map(|(item_id, amount)| ((*item_id).to_owned(), *amount))
            .collect::<BTreeMap<_, _>>();
        let tray_returns = returns
            .iter()
            .map(|(item_id, amount)| ((*item_id).to_owned(), *amount))
            .collect::<BTreeMap<_, _>>();
        let touched_tray_items = costs
            .iter()
            .map(|(item_id, _)| (*item_id).to_owned())
            .collect::<BTreeSet<_>>();
        RepeatableBatch {
            jobs_per_cycle: 1,
            work_seconds: 1.0,
            tray_costs,
            tray_returns,
            fleet_returns: BTreeMap::new(),
            produced_items: produced
                .iter()
                .map(|(item_id, amount)| ((*item_id).to_owned(), *amount))
                .collect(),
            relevant_items: touched_tray_items.clone(),
            touched_tray_items,
            cycle_state_items: Vec::new(),
            cycle_start_inventory: BTreeMap::new(),
        }
    }

    fn quantum_probe_catalog() -> RuntimeCatalog {
        RuntimeCatalog::validate(
            CatalogSnapshot {
                protocol_version: crate::CORE_PROTOCOL_VERSION,
                registry_fingerprint: "construction-parallel".to_owned(),
                planets: vec![PlanetDefinition {
                    id: "planet-a".to_owned(),
                    name: "planet-a".to_owned(),
                    system_id: "system-a".to_owned(),
                    kind: "terrestrial".to_owned(),
                    orbit_index: 1,
                    simulation_order: 0,
                    orbital_yields: std::collections::HashMap::new(),
                }],
                items: ["copper", "iron"]
                    .into_iter()
                    .map(|id| ItemDefinition {
                        id: id.to_owned(),
                        name: id.to_owned(),
                        kind: "solid".to_owned(),
                        fuel_energy_mj: 0.0,
                    })
                    .collect(),
                buildings: Vec::new(),
                recipes: Vec::new(),
                constructions: vec![ConstructionDefinition {
                    id: "widget".to_owned(),
                    output_amount: 1.0,
                    automation_order: 0,
                    required_tech_id: None,
                    costs: vec![
                        ItemAmount {
                            item_id: "iron".to_owned(),
                            amount: 7.0,
                        },
                        ItemAmount {
                            item_id: "copper".to_owned(),
                            amount: 3.0,
                        },
                    ],
                }],
                belts: Vec::new(),
                proliferators: Vec::new(),
                technologies: Vec::new(),
            },
            "construction-parallel",
        )
        .expect("construction probe catalog")
    }

    fn quantum_probe_fixture(
        center_count: usize,
    ) -> (
        CoreState,
        Map<String, Value>,
        Map<String, Value>,
        Vec<Value>,
    ) {
        let catalog = quantum_probe_catalog();
        let base = object(json!({
            "activePlanetId": "planet-a",
            "tray": { "copper": 0, "iron": 1 },
            "planetTrays": {},
        }));
        let mut jobs = Map::new();
        let mut buffers = Map::new();
        let mut entities = Vec::with_capacity(center_count);
        for index in (0..center_count).rev() {
            let entity_id = format!("center-{index:05}");
            entities.push(json!({
                "id": entity_id,
                "buildingId": "construction_center",
                "planetId": "planet-a",
                "powerFactor": if index % 19 == 0 { 0.0 } else { 1.0 },
            }));
            jobs.insert(
                entity_id.clone(),
                json!({
                    "constructionId": "widget",
                    "stepIndex": 0,
                    "elapsedSeconds": 0,
                    "inventory": { "iron": index % 3 },
                    "steps": [{ "kind": "building", "constructionId": "widget" }],
                }),
            );
            if index % 7 == 0 {
                buffers.insert(entity_id, json!({ "iron": 1 }));
            }
        }
        let automation = object(json!({
            "enabled": true,
            "quantumSourceEnabled": true,
            "jobs": jobs,
            "quantumMaterialBuffer": buffers,
        }));
        let mut state = crate::simple_factory::tests::fixture_state(&entities);
        state.catalog = Arc::new(catalog);
        (state, base, automation, entities)
    }

    fn demand_projection(
        demands: &[QuantumDemand],
    ) -> Vec<(String, usize, Option<usize>, String, String, u64)> {
        demands
            .iter()
            .map(|demand| {
                (
                    demand.key.clone(),
                    demand.entity_index,
                    demand.active_row,
                    demand.entity_id.clone(),
                    demand.item_id.clone(),
                    demand.amount,
                )
            })
            .collect()
    }

    fn demand_bytes(demands: &[QuantumDemand]) -> Vec<u8> {
        serde_json::to_vec(
            &demands
                .iter()
                .map(|demand| {
                    json!({
                        "key": demand.key,
                        "entityIndex": demand.entity_index,
                        "activeRow": demand.active_row,
                        "entityId": demand.entity_id,
                        "itemId": demand.item_id,
                        "amount": demand.amount,
                    })
                })
                .collect::<Vec<_>>(),
        )
        .expect("serialize construction demands")
    }

    fn active_runtime_catalog() -> RuntimeCatalog {
        active_runtime_catalog_with_iron_cost(1.0)
    }

    fn active_runtime_catalog_with_iron_cost(iron_cost: f64) -> RuntimeCatalog {
        RuntimeCatalog::validate(
            CatalogSnapshot {
                protocol_version: crate::CORE_PROTOCOL_VERSION,
                registry_fingerprint: "construction-active-runtime".to_owned(),
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
                    id: "iron".to_owned(),
                    name: "iron".to_owned(),
                    kind: "solid".to_owned(),
                    fuel_energy_mj: 0.0,
                }],
                buildings: vec![BuildingDefinition {
                    id: "construction_center".to_owned(),
                    kind: "machine".to_owned(),
                    speed: 1.0,
                    input_capacity: 0.0,
                    output_capacity: 0.0,
                    power_demand_kw: 12_000.0,
                    power_generation_kw: 0.0,
                    power_charge_kw: 0.0,
                    energy_capacity_mj: 0.0,
                    fuel_item_ids: Vec::new(),
                    fuel_efficiency: 1.0,
                    family: None,
                    accepts: None,
                }],
                recipes: Vec::new(),
                constructions: vec![ConstructionDefinition {
                    id: "widget".to_owned(),
                    output_amount: 1.0,
                    automation_order: 0,
                    required_tech_id: None,
                    costs: vec![ItemAmount {
                        item_id: "iron".to_owned(),
                        amount: iron_cost,
                    }],
                }],
                belts: Vec::new(),
                proliferators: Vec::new(),
                technologies: Vec::new(),
            },
            "construction-active-runtime",
        )
        .expect("construction active runtime catalog")
    }

    fn active_runtime_entities(center_count: usize, extension_id: bool) -> Vec<Value> {
        (0..center_count)
            .map(|index| {
                json!({
                    "id": if extension_id && index == 0 {
                        "mod:center-00000".to_owned()
                    } else {
                        format!("center-{index:05}")
                    },
                    "kind": "machine",
                    "planetId": "home",
                    "powerGridId": "grid-a",
                    "powerPriority": 2,
                    "buildingId": "construction_center",
                    "recipeId": null,
                    "machineCount": 1,
                    "minerCount": 0,
                    "inputs": {},
                    "outputs": {},
                    "progress": 0,
                    "utilization": 0,
                    "productionRate": 0,
                    "routingCursor": 0,
                })
            })
            .collect()
    }

    fn active_runtime_base(target: u64, iron: u64) -> Map<String, Value> {
        object(json!({
            "mode": "normal",
            "activePlanetId": "home",
            "tray": { "iron": iron },
            "planetTrays": {},
            "planetTrayItemLimits": { "home": 1_000_000 },
            "construction": { "widget": 0 },
            "portableFleet": { "logistics_drone": 0, "logistics_vessel": 0 },
            "totalProduced": {},
            "research": { "completedTechIds": [] },
            "orbitalStation": { "status": "eligible" },
            "quantumLogisticsNetwork": { "inventory": {} },
            "constructionAutomation": {
                "enabled": true,
                "quantumSourceEnabled": true,
                "targetStock": { "widget": target },
                "jobs": {},
                "destroyedByproducts": {},
                "cursor": 0,
                "totalCrafted": 0
            }
        }))
    }

    type ActiveRuntimeFixture = (
        CoreState,
        Map<String, Value>,
        Vec<Value>,
        HashMap<usize, f64>,
        ConstructionRuntime,
    );

    fn active_runtime_fixture(
        center_count: usize,
        target: u64,
        iron: u64,
        extension_id: bool,
    ) -> ActiveRuntimeFixture {
        let entities = active_runtime_entities(center_count, extension_id);
        let mut state = crate::simple_factory::tests::fixture_state(&entities);
        state.catalog = Arc::new(active_runtime_catalog());
        let base = active_runtime_base(target, iron);
        let runtime = ConstructionRuntime::build(&state, &base, &entities);
        let power_factors = (0..center_count).map(|index| (index, 1.0)).collect();
        (state, base, entities, power_factors, runtime)
    }

    fn run_active_fixture(
        state: &CoreState,
        base: &mut Map<String, Value>,
        entities: &mut [Value],
        power_factors: &HashMap<usize, f64>,
        runtime: &mut ConstructionRuntime,
        seconds: f64,
    ) -> ConstructionRunOutcome {
        run_centers(
            state,
            base,
            entities,
            seconds,
            power_factors,
            &state.factory_topology.construction_center_indices,
            runtime,
        )
        .expect("run active construction fixture")
    }

    fn install_long_build_job(base: &mut Map<String, Value>, entity_id: &str, step_count: usize) {
        let steps = (0..step_count)
            .map(|_| json!({ "kind": "building", "constructionId": "widget" }))
            .collect::<Vec<_>>();
        base["constructionAutomation"]["jobs"][entity_id] = json!({
            "constructionId": "widget",
            "steps": steps,
            "stepIndex": 0,
            "elapsedSeconds": 0,
            "inventory": { "iron": step_count },
        });
    }

    fn configure_center_machine_count(entities: &mut [Value], machine_count: u64) {
        for entity in entities {
            entity["machineCount"] = Value::from(machine_count);
        }
    }

    #[test]
    fn planet_budget_is_fair_between_centers_and_returns_an_idle_centers_share() {
        let (state, mut base, mut entities, power, mut runtime) =
            active_runtime_fixture(2, 400, 0, false);
        configure_center_machine_count(&mut entities, 1_000);
        for index in 0..2 {
            install_long_build_job(&mut base, &format!("center-{index:05}"), 200);
        }
        let outcome =
            run_active_fixture(&state, &mut base, &mut entities, &power, &mut runtime, 1.0);
        assert_eq!(outcome.receipt.crafted, 256);
        assert_eq!(finite_number(base["construction"].get("widget")), 256.0);
        assert_eq!(
            finite_number(
                base["constructionAutomation"]["jobs"]["center-00000"]
                    .as_object()
                    .and_then(|job| job.get("stepIndex"))
            ),
            128.0
        );
        assert_eq!(
            finite_number(
                base["constructionAutomation"]["jobs"]["center-00001"]
                    .as_object()
                    .and_then(|job| job.get("stepIndex"))
            ),
            128.0
        );

        let (state, mut base, mut entities, mut power, mut runtime) =
            active_runtime_fixture(2, 200, 0, false);
        configure_center_machine_count(&mut entities, 1_000);
        install_long_build_job(&mut base, "center-00001", 200);
        power.insert(0, 0.0);
        let outcome =
            run_active_fixture(&state, &mut base, &mut entities, &power, &mut runtime, 1.0);
        assert_eq!(outcome.receipt.crafted, 200);
        assert_eq!(finite_number(base["construction"].get("widget")), 200.0);
        assert!(
            base["constructionAutomation"]["jobs"]
                .as_object()
                .is_some_and(Map::is_empty)
        );
    }

    #[test]
    fn construction_budget_is_identical_for_single_and_segmented_seconds() {
        let (state, mut single_base, mut single_entities, power, mut single_runtime) =
            active_runtime_fixture(1, 200, 0, false);
        configure_center_machine_count(&mut single_entities, 1_000);
        install_long_build_job(&mut single_base, "center-00000", 200);

        let mut segmented_base = single_base.clone();
        let mut segmented_entities = single_entities.clone();
        let mut segmented_runtime =
            ConstructionRuntime::build(&state, &segmented_base, &segmented_entities);
        run_active_fixture(
            &state,
            &mut single_base,
            &mut single_entities,
            &power,
            &mut single_runtime,
            1.0,
        );
        for _ in 0..2 {
            run_active_fixture(
                &state,
                &mut segmented_base,
                &mut segmented_entities,
                &power,
                &mut segmented_runtime,
                0.5,
            );
        }
        assert_eq!(segmented_base, single_base);
        assert_eq!(segmented_entities, single_entities);
        assert_eq!(
            serde_json::to_vec(&(&segmented_base, &segmented_entities))
                .expect("segmented construction bytes"),
            serde_json::to_vec(&(&single_base, &single_entities))
                .expect("single construction bytes")
        );
    }

    #[test]
    fn active_center_runtime_matches_full_scan_oracle_and_serializes_identically_when_quiet() {
        let (state, mut active_base, mut active_entities, power, mut active_runtime) =
            active_runtime_fixture(4, 1, 1, false);
        let mut oracle_base = active_base.clone();
        let mut oracle_entities = active_entities.clone();
        let mut oracle_runtime = ConstructionRuntime::build(&state, &oracle_base, &oracle_entities);
        oracle_runtime.force_full_scan();
        let mut selected = Vec::new();
        for _ in 0..3 {
            let active = run_active_fixture(
                &state,
                &mut active_base,
                &mut active_entities,
                &power,
                &mut active_runtime,
                5.0,
            );
            let oracle = run_active_fixture(
                &state,
                &mut oracle_base,
                &mut oracle_entities,
                &power,
                &mut oracle_runtime,
                5.0,
            );
            assert_eq!(active.receipt, oracle.receipt);
            selected.push(active.scan.selected_rows);
            assert_eq!(oracle.scan.selected_rows, 4);
            assert!(oracle.scan.directory_fallback);
            assert_eq!(active_base, oracle_base);
            assert_eq!(active_entities, oracle_entities);
            assert_eq!(
                serde_json::to_vec(&(&active_base, &active_entities)).expect("active bytes"),
                serde_json::to_vec(&(&oracle_base, &oracle_entities)).expect("oracle bytes")
            );
        }
        assert_eq!(selected, vec![4, 4, 0]);
        assert_eq!(
            inventory_amount(active_base["construction"].as_object().unwrap(), "widget"),
            1.0
        );
    }

    #[test]
    fn construction_run_receipt_is_stable_and_revision_bounded() {
        let (state, mut base, mut entities, power, mut runtime) =
            active_runtime_fixture(4, 3, 3, false);
        let outcome =
            run_active_fixture(&state, &mut base, &mut entities, &power, &mut runtime, 5.0);
        assert_eq!(outcome.receipt.crafted, 3);
        assert_eq!(
            outcome.receipt.outputs,
            BTreeMap::from([("widget".to_owned(), 3)])
        );
        assert_eq!(
            runtime.receipt_between(state.revision, state.revision + 1),
            Some(outcome.receipt.clone())
        );
        assert_eq!(
            runtime.receipt_between(state.revision + 1, state.revision + 2),
            None
        );

        let mut stable = ConstructionRunReceipt::default();
        stable.record_completion(Some("z-output"), 1.0);
        stable.record_completion(Some("a-output"), 2.0);
        stable.record_completion(Some("z-output"), 3.0);
        assert_eq!(
            stable.outputs.into_iter().collect::<Vec<_>>(),
            vec![("a-output".to_owned(), 2), ("z-output".to_owned(), 4)]
        );

        let mut bounded = ConstructionRuntime::build(&state, &base, &entities);
        for offset in 0..=CONSTRUCTION_RECEIPT_HISTORY_LIMIT {
            let mut row = ConstructionRunReceipt::default();
            row.record_completion(Some("widget"), 1.0);
            bounded.record_run_receipt(state.revision + offset as u64, &row);
        }
        assert_eq!(
            bounded.receipt_between(
                state.revision,
                state.revision + CONSTRUCTION_RECEIPT_HISTORY_LIMIT as u64 + 1,
            ),
            None,
            "an evicted revision must fail closed",
        );
        assert_eq!(
            bounded
                .receipt_between(
                    state.revision + 1,
                    state.revision + CONSTRUCTION_RECEIPT_HISTORY_LIMIT as u64 + 1,
                )
                .expect("retained construction receipt window")
                .crafted,
            CONSTRUCTION_RECEIPT_HISTORY_LIMIT as i128,
        );

        let mut fractional = ConstructionRunReceipt::default();
        fractional.record_completion(Some("mod:fractional-widget"), 0.5);
        bounded.record_run_receipt(
            state.revision + CONSTRUCTION_RECEIPT_HISTORY_LIMIT as u64 + 1,
            &fractional,
        );
        assert_eq!(
            bounded.receipt_between(
                state.revision + CONSTRUCTION_RECEIPT_HISTORY_LIMIT as u64 + 1,
                state.revision + CONSTRUCTION_RECEIPT_HISTORY_LIMIT as u64 + 2,
            ),
            None,
            "fractional MOD output cannot become settlement authority",
        );
    }

    #[test]
    fn sleeping_centers_wake_on_planet_inventory_increase_and_power_group_change() {
        let (state, mut base, mut entities, power, mut runtime) =
            active_runtime_fixture(4, 1, 0, false);
        assert_eq!(
            run_active_fixture(&state, &mut base, &mut entities, &power, &mut runtime, 5.0)
                .scan
                .selected_rows,
            4
        );
        assert_eq!(
            run_active_fixture(&state, &mut base, &mut entities, &power, &mut runtime, 5.0)
                .scan
                .selected_rows,
            0
        );
        set_inventory_amount(tray_mut(&mut base, "home").expect("home tray"), "iron", 1.0)
            .expect("supply construction material");
        let inventory_wake =
            run_active_fixture(&state, &mut base, &mut entities, &power, &mut runtime, 5.0);
        assert_eq!(inventory_wake.scan.selected_rows, 4);
        assert!(inventory_wake.scan.dense_fallback);
        assert_eq!(
            inventory_amount(base["construction"].as_object().unwrap(), "widget"),
            1.0
        );

        let (state, mut base, mut entities, mut power, mut runtime) =
            active_runtime_fixture(4, 1, 1, false);
        power.values_mut().for_each(|factor| *factor = 0.0);
        assert_eq!(
            run_active_fixture(&state, &mut base, &mut entities, &power, &mut runtime, 5.0)
                .scan
                .selected_rows,
            4
        );
        assert_eq!(
            run_active_fixture(&state, &mut base, &mut entities, &power, &mut runtime, 5.0)
                .scan
                .selected_rows,
            0
        );
        power.values_mut().for_each(|factor| *factor = 1.0);
        let power_wake =
            run_active_fixture(&state, &mut base, &mut entities, &power, &mut runtime, 5.0);
        assert_eq!(power_wake.scan.selected_rows, 4);
        assert!(power_wake.scan.dense_fallback);
        assert_eq!(
            inventory_amount(base["construction"].as_object().unwrap(), "widget"),
            1.0
        );
    }

    #[test]
    fn raw_power_signature_wakes_across_epsilon_inside_one_display_bucket_and_matches_oracle() {
        const BELOW_EPSILON: f64 = 0.00009;
        const ABOVE_EPSILON: f64 = 0.00011;
        assert_eq!(
            (BELOW_EPSILON * 10_000.0).round() / 10_000.0,
            (ABOVE_EPSILON * 10_000.0).round() / 10_000.0,
            "the regression factors must share the persisted display bucket"
        );

        let (state, mut active_base, mut active_entities, mut active_power, mut active_runtime) =
            active_runtime_fixture(4, 1, 1, false);
        let mut oracle_base = active_base.clone();
        let mut oracle_entities = active_entities.clone();
        let mut oracle_power = active_power.clone();
        let mut oracle_runtime = ConstructionRuntime::build(&state, &oracle_base, &oracle_entities);
        oracle_runtime.force_full_scan();
        active_power
            .values_mut()
            .for_each(|factor| *factor = BELOW_EPSILON);
        oracle_power
            .values_mut()
            .for_each(|factor| *factor = BELOW_EPSILON);

        let initial = run_active_fixture(
            &state,
            &mut active_base,
            &mut active_entities,
            &active_power,
            &mut active_runtime,
            5.0,
        );
        let oracle_initial = run_active_fixture(
            &state,
            &mut oracle_base,
            &mut oracle_entities,
            &oracle_power,
            &mut oracle_runtime,
            5.0,
        );
        assert_eq!(initial.scan.selected_rows, 4);
        assert_eq!(oracle_initial.scan.selected_rows, 4);
        assert_eq!(active_base, oracle_base);
        assert_eq!(active_entities, oracle_entities);

        let quiet = run_active_fixture(
            &state,
            &mut active_base,
            &mut active_entities,
            &active_power,
            &mut active_runtime,
            5.0,
        );
        let oracle_quiet = run_active_fixture(
            &state,
            &mut oracle_base,
            &mut oracle_entities,
            &oracle_power,
            &mut oracle_runtime,
            5.0,
        );
        assert_eq!(quiet.scan.selected_rows, 0);
        assert_eq!(oracle_quiet.scan.selected_rows, 4);
        assert_eq!(active_base, oracle_base);
        assert_eq!(active_entities, oracle_entities);

        active_power
            .values_mut()
            .for_each(|factor| *factor = ABOVE_EPSILON);
        oracle_power
            .values_mut()
            .for_each(|factor| *factor = ABOVE_EPSILON);
        let wake = run_active_fixture(
            &state,
            &mut active_base,
            &mut active_entities,
            &active_power,
            &mut active_runtime,
            5.0,
        );
        let oracle_wake = run_active_fixture(
            &state,
            &mut oracle_base,
            &mut oracle_entities,
            &oracle_power,
            &mut oracle_runtime,
            5.0,
        );
        assert_eq!(wake.scan.selected_rows, 4);
        assert!(wake.scan.dense_fallback);
        assert_eq!(oracle_wake.scan.selected_rows, 4);
        assert_eq!(active_base, oracle_base);
        assert_eq!(active_entities, oracle_entities);
        assert_eq!(
            serde_json::to_vec(&(&active_base, &active_entities)).expect("active bytes"),
            serde_json::to_vec(&(&oracle_base, &oracle_entities)).expect("oracle bytes")
        );
        assert!(
            active_base["constructionAutomation"]["jobs"]
                .as_object()
                .is_some_and(|jobs| !jobs.is_empty()),
            "the awakened center must start work above EPSILON"
        );
    }

    #[test]
    fn failed_candidate_does_not_drain_source_runtime_wait_state() {
        let (state, mut base, mut entities, power, mut runtime) =
            active_runtime_fixture(4, 1, 0, false);
        let blocked =
            run_active_fixture(&state, &mut base, &mut entities, &power, &mut runtime, 5.0);
        assert_eq!(blocked.scan.selected_rows, 4);
        assert_eq!(runtime.planet_wait_rows[0].len(), 4);
        assert_eq!(runtime.planner_wait_rows.len(), 4);

        let source_runtime = Arc::new(runtime);
        let source_planet_wait_rows = source_runtime.planet_wait_rows.clone();
        let source_planner_wait_rows = source_runtime.planner_wait_rows.clone();
        let source_inventory = source_runtime.observed_planet_inventory.clone();
        let source_base_bytes = serde_json::to_vec(&base).expect("source base bytes");
        let mut candidate_runtime = Arc::clone(&source_runtime);
        let mut candidate_base = base.clone();
        let mut candidate_entities = entities.clone();
        set_inventory_amount(
            tray_mut(&mut candidate_base, "home").expect("candidate home tray"),
            "iron",
            1.0,
        )
        .expect("wake candidate wait rows");
        candidate_base["constructionAutomation"]["jobs"] = Value::Null;
        let candidate_power_plan = Arc::make_mut(&mut candidate_runtime).power_demand_plan(
            &state,
            &candidate_base,
            &candidate_entities,
            &state.factory_topology.construction_center_indices,
            1.0,
        );
        assert!(candidate_power_plan.has_deficit);

        let error = run_centers(
            &state,
            &mut candidate_base,
            &mut candidate_entities,
            5.0,
            &power,
            &state.factory_topology.construction_center_indices,
            Arc::make_mut(&mut candidate_runtime),
        )
        .expect_err("malformed candidate jobs must fail after selecting wake rows");
        assert_eq!(error.to_string(), "native construction jobs are missing");
        assert!(!Arc::ptr_eq(&source_runtime, &candidate_runtime));
        assert_eq!(source_runtime.planet_wait_rows, source_planet_wait_rows);
        assert_eq!(source_runtime.planner_wait_rows, source_planner_wait_rows);
        assert_eq!(source_runtime.observed_planet_inventory, source_inventory);
        assert_eq!(
            serde_json::to_vec(&base).expect("source base bytes after failure"),
            source_base_bytes
        );
        assert!(candidate_runtime.planet_wait_rows[0].is_empty());
        assert!(candidate_runtime.planner_wait_rows.is_empty());
    }

    #[test]
    fn serialized_job_wait_and_quantum_buffer_rebuild_matches_live_and_full_scan_oracle() {
        let (mut state, mut live_base, mut live_entities, power, _) =
            active_runtime_fixture(4, 1, 0, false);
        state.catalog = Arc::new(active_runtime_catalog_with_iron_cost(2.0));
        let center_id = state.entities.ids[2].to_string();
        live_base["constructionAutomation"]["jobs"][&center_id] = json!({
            "constructionId": "widget",
            "steps": [{ "kind": "building", "constructionId": "widget" }],
            "stepIndex": 0,
            "elapsedSeconds": 0,
            "inventory": {}
        });
        live_base["constructionAutomation"]["quantumMaterialBuffer"] = Value::Object(
            [(center_id.clone(), json!({ "iron": 1 }))]
                .into_iter()
                .collect(),
        );
        let mut live_runtime = ConstructionRuntime::build(&state, &live_base, &live_entities);
        let blocked = run_active_fixture(
            &state,
            &mut live_base,
            &mut live_entities,
            &power,
            &mut live_runtime,
            5.0,
        );
        assert_eq!(blocked.quantum_wake.center_indices, vec![2]);
        assert!(live_runtime.planet_wait_rows[0].contains(&2));
        assert_eq!(
            live_base["constructionAutomation"]["quantumMaterialBuffer"][&center_id]["iron"],
            Value::from(1)
        );

        let persisted =
            serde_json::to_vec(&(&live_base, &live_entities)).expect("serialize persisted domains");
        let (mut restored_base, mut restored_entities): (Map<String, Value>, Vec<Value>) =
            serde_json::from_slice(&persisted).expect("restore persisted domains");
        assert_eq!(
            serde_json::to_vec(&(&restored_base, &restored_entities))
                .expect("reserialize persisted domains"),
            persisted
        );
        let mut restored_runtime =
            ConstructionRuntime::build(&state, &restored_base, &restored_entities);
        let mut oracle_base = restored_base.clone();
        let mut oracle_entities = restored_entities.clone();
        let mut oracle_runtime = ConstructionRuntime::build(&state, &oracle_base, &oracle_entities);
        oracle_runtime.force_full_scan();

        let live_quiet = run_active_fixture(
            &state,
            &mut live_base,
            &mut live_entities,
            &power,
            &mut live_runtime,
            5.0,
        );
        let restored_full = run_active_fixture(
            &state,
            &mut restored_base,
            &mut restored_entities,
            &power,
            &mut restored_runtime,
            5.0,
        );
        let oracle_full = run_active_fixture(
            &state,
            &mut oracle_base,
            &mut oracle_entities,
            &power,
            &mut oracle_runtime,
            5.0,
        );
        assert_eq!(live_quiet.scan.selected_rows, 0);
        assert_eq!(restored_full.scan.selected_rows, 4);
        assert_eq!(oracle_full.scan.selected_rows, 4);
        assert_eq!(live_base, restored_base);
        assert_eq!(live_base, oracle_base);
        assert_eq!(live_entities, restored_entities);
        assert_eq!(live_entities, oracle_entities);

        let live_power_plan = live_runtime.power_demand_plan(
            &state,
            &live_base,
            &live_entities,
            &state.factory_topology.construction_center_indices,
            1.0,
        );
        let restored_power_plan = restored_runtime.power_demand_plan(
            &state,
            &restored_base,
            &restored_entities,
            &state.factory_topology.construction_center_indices,
            1.0,
        );
        assert_eq!(live_power_plan, restored_power_plan);
        assert!(live_power_plan.aggregate_candidate);

        for base in [&mut live_base, &mut restored_base, &mut oracle_base] {
            set_inventory_amount(
                tray_mut(base, "home").expect("home tray after recovery"),
                "iron",
                1.0,
            )
            .expect("complete recovered job material");
        }
        let live_wake = run_active_fixture(
            &state,
            &mut live_base,
            &mut live_entities,
            &power,
            &mut live_runtime,
            5.0,
        );
        let restored_wake = run_active_fixture(
            &state,
            &mut restored_base,
            &mut restored_entities,
            &power,
            &mut restored_runtime,
            5.0,
        );
        let oracle_wake = run_active_fixture(
            &state,
            &mut oracle_base,
            &mut oracle_entities,
            &power,
            &mut oracle_runtime,
            5.0,
        );
        assert_eq!(live_wake.scan.selected_rows, 1);
        assert_eq!(restored_wake.scan.selected_rows, 1);
        assert_eq!(oracle_wake.scan.selected_rows, 4);
        assert_eq!(live_base, restored_base);
        assert_eq!(live_base, oracle_base);
        assert_eq!(live_entities, restored_entities);
        assert_eq!(live_entities, oracle_entities);
        assert_eq!(
            serde_json::to_vec(&(&live_base, &live_entities)).expect("live final bytes"),
            serde_json::to_vec(&(&oracle_base, &oracle_entities)).expect("oracle final bytes")
        );
    }

    #[test]
    fn construction_runtime_memory_estimate_counts_wait_trees_and_inventory_entries() {
        let (state, mut base, mut entities, power, mut runtime) =
            active_runtime_fixture(4, 1, 0, false);
        let before = runtime.estimated_bytes();
        run_active_fixture(&state, &mut base, &mut entities, &power, &mut runtime, 5.0);
        assert_eq!(runtime.planet_wait_rows[0].len(), 4);
        assert_eq!(runtime.planner_wait_rows.len(), 4);
        let tree_keys = runtime
            .planet_wait_rows
            .iter()
            .map(BTreeSet::len)
            .sum::<usize>()
            + runtime.planner_wait_rows.len()
            + runtime.pending.len();
        let nonempty_trees = runtime
            .planet_wait_rows
            .iter()
            .filter(|rows| !rows.is_empty())
            .count()
            + usize::from(!runtime.planner_wait_rows.is_empty())
            + usize::from(!runtime.pending.is_empty());
        let tree_growth = (tree_keys * 4 + nonempty_trees * 16) * std::mem::size_of::<usize>();
        let inventory_growth = std::mem::size_of::<(String, u64)>() + "iron".len();
        assert!(
            runtime.estimated_bytes()
                >= before + u64::try_from(tree_growth + inventory_growth).unwrap(),
            "the public memory gate must conservatively include wait-tree nodes and inventory entry storage"
        );
    }

    #[test]
    fn exact_quantum_delivery_wakes_only_its_sleeping_center() {
        let (state, mut base, mut entities, power, _) = active_runtime_fixture(4, 1, 0, false);
        let center_id = state.entities.ids[2].to_string();
        base["constructionAutomation"]["jobs"][&center_id] = json!({
            "constructionId": "widget",
            "steps": [{ "kind": "building", "constructionId": "widget" }],
            "stepIndex": 0,
            "elapsedSeconds": 0,
            "inventory": {}
        });
        let mut runtime = ConstructionRuntime::build(&state, &base, &entities);
        let first = run_active_fixture(&state, &mut base, &mut entities, &power, &mut runtime, 5.0);
        assert_eq!(first.scan.selected_rows, 4);
        assert_eq!(first.quantum_wake.center_indices, vec![2]);
        assert_eq!(
            run_active_fixture(&state, &mut base, &mut entities, &power, &mut runtime, 5.0)
                .scan
                .selected_rows,
            0
        );
        let demand = QuantumDemand {
            key: format!("construction-direct:{center_id}:iron"),
            entity_index: 2,
            active_row: None,
            entity_id: center_id,
            item_id: "iron".to_owned(),
            amount: 1,
        };
        assert_eq!(
            apply_quantum_delivery(&mut base, &demand, 1).expect("direct quantum delivery"),
            1
        );
        runtime.wake_center_indices(&[2]);
        let wake = run_active_fixture(&state, &mut base, &mut entities, &power, &mut runtime, 5.0);
        assert_eq!(wake.scan.selected_rows, 1);
        assert!(!wake.scan.dense_fallback);
        assert_eq!(
            inventory_amount(base["construction"].as_object().unwrap(), "widget"),
            1.0
        );
    }

    #[test]
    fn active_queue_is_stable_and_uses_exact_three_quarters_dense_fallback() {
        let (state, mut base, mut entities, power, mut runtime) =
            active_runtime_fixture(4, 0, 0, false);
        run_active_fixture(&state, &mut base, &mut entities, &power, &mut runtime, 1.0);
        runtime.wake_center_indices(&[3, 1]);
        let (selected, sparse) = runtime.selected_rows(
            &state,
            &base,
            &entities,
            &power,
            &state.factory_topology.construction_center_indices,
        );
        assert_eq!(selected, vec![1, 3]);
        assert_eq!(sparse.selected_rows, 2);
        assert!(!sparse.dense_fallback);

        let (state, mut base, mut entities, power, mut runtime) =
            active_runtime_fixture(4, 0, 0, false);
        run_active_fixture(&state, &mut base, &mut entities, &power, &mut runtime, 1.0);
        runtime.wake_center_indices(&[3, 1, 2]);
        let (selected, dense) = runtime.selected_rows(
            &state,
            &base,
            &entities,
            &power,
            &state.factory_topology.construction_center_indices,
        );
        assert_eq!(selected, vec![0, 1, 2, 3]);
        assert_eq!(dense.selected_rows, 4);
        assert!(dense.dense_fallback);
        assert!(!dense.directory_fallback);
    }

    #[test]
    fn sparse_power_demand_plan_matches_full_center_load_and_closes_target_wakes() {
        let (state, mut base, mut entities, power, mut runtime) =
            active_runtime_fixture(8, 10, 1, false);
        for _ in 0..3 {
            run_active_fixture(&state, &mut base, &mut entities, &power, &mut runtime, 5.0);
        }
        assert!(has_deficit(&state, &base));
        assert!(!runtime.all_pending);
        assert!(runtime.pending.is_empty());

        let indexed = runtime.power_demand_plan(
            &state,
            &base,
            &entities,
            &state.factory_topology.construction_center_indices,
            1.0,
        );
        assert!(indexed.has_deficit);
        assert!(indexed.aggregate_candidate);
        assert!(!indexed.directory_fallback);
        assert_eq!(indexed.groups.len(), 1);
        assert_eq!(indexed.groups[0].center_count, 8);
        let building = state
            .catalog
            .buildings
            .get("construction_center")
            .expect("construction power definition");
        let forced_full_demand = state
            .factory_topology
            .construction_center_indices
            .iter()
            .map(|&entity_index| {
                building.power_demand_kw * finite_number(entities[entity_index].get("machineCount"))
            })
            .sum::<f64>();
        assert_eq!(
            indexed.groups[0].demand_kw.to_bits(),
            forced_full_demand.to_bits()
        );

        for factor in [EPSILON - 0.00000001, EPSILON + 0.00000001] {
            let mut indexed_base = base.clone();
            let mut indexed_entities = entities.clone();
            let mut indexed_runtime = runtime.clone();
            indexed_runtime.use_aggregated_power_factors(true);
            let indexed_power =
                HashMap::from([(indexed.groups[0].representative_entity_index, factor)]);
            let indexed_outcome = run_active_fixture(
                &state,
                &mut indexed_base,
                &mut indexed_entities,
                &indexed_power,
                &mut indexed_runtime,
                1.0,
            );

            let mut oracle_base = base.clone();
            let mut oracle_entities = entities.clone();
            let mut oracle_runtime = runtime.clone();
            oracle_runtime.force_full_scan();
            let oracle_power = state
                .factory_topology
                .construction_center_indices
                .iter()
                .copied()
                .map(|entity_index| (entity_index, factor))
                .collect::<HashMap<_, _>>();
            let oracle_outcome = run_active_fixture(
                &state,
                &mut oracle_base,
                &mut oracle_entities,
                &oracle_power,
                &mut oracle_runtime,
                1.0,
            );
            assert_eq!(indexed_outcome.scan.selected_rows, 8);
            assert_eq!(oracle_outcome.scan.selected_rows, 8);
            assert_eq!(indexed_base, oracle_base);
            assert_eq!(indexed_entities, oracle_entities);
            assert_eq!(
                serde_json::to_vec(&(&indexed_base, &indexed_entities)).unwrap(),
                serde_json::to_vec(&(&oracle_base, &oracle_entities)).unwrap()
            );
        }

        base["constructionAutomation"]["targetStock"]["widget"] = Value::from(1);
        let cleared = runtime.power_demand_plan(
            &state,
            &base,
            &entities,
            &state.factory_topology.construction_center_indices,
            1.0,
        );
        assert!(!cleared.has_deficit);
        assert!(cleared.groups.is_empty());
        assert!(
            runtime.all_pending,
            "target change must wake every sleeping center"
        );

        base["constructionAutomation"]["targetStock"]["widget"] = Value::from(10);
        let dense = runtime.power_demand_plan(
            &state,
            &base,
            &entities,
            &state.factory_topology.construction_center_indices,
            1.0,
        );
        assert!(dense.has_deficit);
        assert!(
            !dense.aggregate_candidate,
            "dense wake must retain the full oracle scan"
        );
        assert!(!dense.directory_fallback);
    }

    #[test]
    fn power_deficit_ignores_locked_targets_and_noncanonical_directory_fails_closed() {
        let (mut state, mut base, entities, _, _) = active_runtime_fixture(4, 1, 0, false);
        let catalog = Arc::make_mut(&mut state.catalog);
        catalog.snapshot.constructions[0].required_tech_id = Some("locked-tech".to_owned());
        catalog
            .constructions
            .get_mut("widget")
            .expect("widget construction")
            .required_tech_id = Some("locked-tech".to_owned());
        let mut runtime = ConstructionRuntime::build(&state, &base, &entities);
        assert!(!has_deficit(&state, &base));
        let locked = runtime.power_demand_plan(
            &state,
            &base,
            &entities,
            &state.factory_topology.construction_center_indices,
            1.0,
        );
        assert!(!locked.has_deficit);

        base["research"]["completedTechIds"] = json!(["locked-tech"]);
        let unlocked = runtime.power_demand_plan(
            &state,
            &base,
            &entities,
            &state.factory_topology.construction_center_indices,
            1.0,
        );
        assert!(unlocked.has_deficit);
        assert!(
            !unlocked.aggregate_candidate,
            "technology wake is deliberately dense"
        );

        let (extension_state, extension_base, extension_entities, _, mut extension_runtime) =
            active_runtime_fixture(4, 1, 0, true);
        let fallback = extension_runtime.power_demand_plan(
            &extension_state,
            &extension_base,
            &extension_entities,
            &extension_state.factory_topology.construction_center_indices,
            1.0,
        );
        assert!(fallback.has_deficit);
        assert!(!fallback.aggregate_candidate);
        assert!(fallback.directory_fallback);
    }

    #[test]
    fn extension_center_id_fails_closed_to_repeatable_full_scan() {
        let (state, mut base, mut entities, power, mut runtime) =
            active_runtime_fixture(3, 0, 0, true);
        for _ in 0..2 {
            let outcome =
                run_active_fixture(&state, &mut base, &mut entities, &power, &mut runtime, 1.0);
            assert_eq!(outcome.scan.selected_rows, 3);
            assert!(outcome.scan.dense_fallback);
            assert!(outcome.scan.directory_fallback);
        }
    }

    #[test]
    fn construction_runtime_is_excluded_from_public_serialization() {
        let mut state = crate::simple_factory::tests::fixture_state(&[]);
        let entities = state
            .take_entities_for_simulation()
            .expect("materialize serialization fixture");
        let mut before = Vec::new();
        state
            .write_v47_envelope(42, &mut before)
            .expect("serialize before construction runtime replacement");
        let canonical_before = state
            .canonical_sha256()
            .expect("canonical hash before construction runtime replacement");
        let mut runtime = ConstructionRuntime::build(&state, state.base_value(), &entities);
        let mut receipt = ConstructionRunReceipt::default();
        receipt.record_completion(Some("runtime-only-widget"), 2.0);
        runtime.record_run_receipt(state.revision, &receipt);
        state.install_prepared_construction_runtime(Arc::new(runtime));
        let mut after = Vec::new();
        state
            .write_v47_envelope(42, &mut after)
            .expect("serialize after construction runtime replacement");
        assert_eq!(after, before);
        assert_eq!(
            state
                .canonical_sha256()
                .expect("canonical hash after construction runtime replacement"),
            canonical_before
        );
    }

    #[test]
    fn construction_center_probe_keeps_small_work_serial_and_enters_bounded_pool_when_large() {
        let (_, _, _, small_entities) = quantum_probe_fixture(32);
        let small_centers = small_entities
            .iter()
            .filter_map(Value::as_object)
            .collect::<Vec<_>>();
        let small_runtime = DeterministicRuntime::for_test(8);
        let small_threads = plan_construction_center_probes(
            &small_runtime,
            &small_centers,
            |index, _| -> anyhow::Result<_> {
                let thread = std::thread::current();
                Ok((index, thread.name().unwrap_or("unnamed").to_owned()))
            },
        )
        .expect("small construction probe");
        assert!(
            small_threads
                .iter()
                .all(|(_, name)| !name.starts_with("dsp-native-core-"))
        );

        let (_, _, _, large_entities) =
            quantum_probe_fixture(crate::deterministic_runtime::PARALLEL_MIN_ITEMS + 257);
        let large_centers = large_entities
            .iter()
            .filter_map(Value::as_object)
            .collect::<Vec<_>>();
        for worker_limit in [2, 4, 8] {
            let runtime = DeterministicRuntime::for_test(worker_limit);
            let observations = plan_construction_center_probes(
                &runtime,
                &large_centers,
                |index, _| -> anyhow::Result<_> {
                    let thread = std::thread::current();
                    Ok((
                        index,
                        rayon::current_num_threads(),
                        thread.name().unwrap_or("unnamed").to_owned(),
                    ))
                },
            )
            .expect("parallel construction probe");
            assert_eq!(
                observations
                    .iter()
                    .map(|(index, _, _)| *index)
                    .collect::<Vec<_>>(),
                (0..large_centers.len()).collect::<Vec<_>>()
            );
            assert!(observations.iter().all(|(_, workers, name)| {
                *workers == worker_limit && name.starts_with("dsp-native-core-")
            }));
        }
    }

    #[test]
    fn quantum_demand_probe_is_byte_identical_for_1_2_4_8_workers() {
        let (state, base, automation, entities) =
            quantum_probe_fixture(crate::deterministic_runtime::PARALLEL_MIN_ITEMS + 257);
        let jobs = automation["jobs"].as_object().expect("construction jobs");
        let expected = collect_quantum_demands_with_runtime(
            &DeterministicRuntime::for_test(1),
            &state,
            &base,
            &automation,
            jobs,
            &entities,
        )
        .expect("serial construction demand probe");
        let expected_projection = demand_projection(&expected);
        let expected_bytes = demand_bytes(&expected);
        assert!(!expected.is_empty());
        assert!(
            expected
                .windows(2)
                .all(|pair| pair[0].entity_id <= pair[1].entity_id)
        );
        assert!(expected.iter().all(|demand| {
            entities[demand.entity_index]["id"].as_str() == Some(demand.entity_id.as_str())
        }));

        for worker_limit in [1, 2, 4, 8] {
            let actual = collect_quantum_demands_with_runtime(
                &DeterministicRuntime::for_test(worker_limit),
                &state,
                &base,
                &automation,
                jobs,
                &entities,
            )
            .expect("construction demand worker matrix");
            assert_eq!(demand_projection(&actual), expected_projection);
            assert_eq!(demand_bytes(&actual), expected_bytes);
        }
    }

    #[test]
    fn no_job_quantum_prefetch_is_recursive_and_identical_for_1_2_4_8_workers() {
        let (state, mut base, mut automation, entities) =
            quantum_probe_fixture(crate::deterministic_runtime::PARALLEL_MIN_ITEMS + 257);
        base.insert("construction".to_owned(), json!({ "widget": 0 }));
        automation.insert("jobs".to_owned(), Value::Object(Map::new()));
        automation.insert("targetStock".to_owned(), json!({ "widget": 1 }));
        let jobs = automation["jobs"].as_object().expect("empty jobs");
        let expected = collect_quantum_demands_with_runtime(
            &DeterministicRuntime::for_test(1),
            &state,
            &base,
            &automation,
            jobs,
            &entities,
        )
        .expect("serial no-job quantum prefetch");
        let powered_center_count = entities
            .iter()
            .filter(|center| finite_number(center.get("powerFactor")) > EPSILON)
            .count();
        assert_eq!(expected.len(), powered_center_count * 2);
        assert_eq!(
            expected
                .iter()
                .filter(|demand| demand.entity_id == "center-00001")
                .map(|demand| (demand.item_id.as_str(), demand.amount))
                .collect::<Vec<_>>(),
            vec![("copper", 3), ("iron", 6)]
        );
        let expected_bytes = demand_bytes(&expected);
        for worker_limit in [1, 2, 4, 8] {
            let actual = collect_quantum_demands_with_runtime(
                &DeterministicRuntime::for_test(worker_limit),
                &state,
                &base,
                &automation,
                jobs,
                &entities,
            )
            .expect("no-job quantum worker matrix");
            assert_eq!(demand_bytes(&actual), expected_bytes);
        }
    }

    #[test]
    fn existing_job_quantum_prefetch_uses_remaining_batch_and_five_second_horizon() {
        let (state, mut base, mut automation, mut entities) = quantum_probe_fixture(1);
        base.insert("construction".to_owned(), json!({ "widget": 0 }));
        automation.insert("targetStock".to_owned(), json!({ "widget": 100 }));
        entities[0]["powerFactor"] = Value::from(1.0);
        entities[0]["machineCount"] = Value::from(100);
        let jobs = automation["jobs"].as_object().expect("existing job");
        let demands = collect_quantum_demands_with_runtime(
            &DeterministicRuntime::for_test(1),
            &state,
            &base,
            &automation,
            jobs,
            &entities,
        )
        .expect("existing-job quantum prefetch");
        assert_eq!(
            demands
                .iter()
                .map(|demand| (demand.item_id.as_str(), demand.amount))
                .collect::<Vec<_>>(),
            vec![("copper", 300), ("iron", 698)]
        );
    }

    #[test]
    fn indexed_quantum_demand_keeps_its_active_directory_row() {
        let (state, base, automation, entities) = quantum_probe_fixture(10);
        let jobs = automation["jobs"].as_object().expect("construction jobs");
        let center_indices = [0, 1, 2];
        let active_rows = [4, 9, 15];
        let demands = collect_quantum_demands_for_center_indices_with_runtime(
            &DeterministicRuntime::for_test(4),
            &QuantumDemandProbeInputs {
                state: &state,
                base: &base,
                automation: &automation,
                jobs,
            },
            &entities,
            &center_indices,
            &active_rows,
        )
        .expect("indexed construction demand probe");
        assert!(!demands.is_empty());
        assert!(demands.iter().all(|demand| {
            let selected_index = center_indices
                .iter()
                .position(|&entity_index| entity_index == demand.entity_index)
                .expect("demand belongs to selected center");
            demand.active_row == Some(active_rows[selected_index])
                && entities[demand.entity_index]["id"].as_str() == Some(demand.entity_id.as_str())
        }));
        assert_eq!(
            demands
                .iter()
                .map(|demand| demand.entity_index)
                .collect::<BTreeSet<_>>(),
            center_indices.into_iter().collect()
        );
    }

    #[test]
    fn quantum_demand_parallel_failure_uses_lowest_center_and_keeps_sources_atomic() {
        let (state, base, mut automation, entities) =
            quantum_probe_fixture(crate::deterministic_runtime::PARALLEL_MIN_ITEMS + 257);
        let jobs = automation["jobs"]
            .as_object_mut()
            .expect("construction jobs");
        jobs["center-01024"]["steps"] = json!([{ "kind": "invalid-low" }]);
        jobs["center-03000"]
            .as_object_mut()
            .expect("higher malformed job")
            .remove("inventory");
        let source_bytes = serde_json::to_vec(&(&base, &automation, &entities))
            .expect("serialize construction source");
        let jobs = automation["jobs"].as_object().expect("construction jobs");

        for worker_limit in [1, 2, 4, 8] {
            let error = collect_quantum_demands_with_runtime(
                &DeterministicRuntime::for_test(worker_limit),
                &state,
                &base,
                &automation,
                jobs,
                &entities,
            )
            .expect_err("malformed construction probe must fail");
            assert_eq!(
                error.to_string(),
                "native construction step kind is invalid"
            );
            assert_eq!(
                serde_json::to_vec(&(&base, &automation, &entities))
                    .expect("serialize construction source after failure"),
                source_bytes
            );
        }
    }

    #[test]
    fn stock_limit_uses_full_first_principal_then_only_net_loss() {
        let base = object(json!({
            "activePlanetId": "planet-a",
            "tray": { "feed": 2 },
            "planetTrays": {},
            "planetTrayItemLimits": { "planet-a": 1_000_000 },
        }));
        let quantum = object(json!({ "feed": 12 }));
        let working_capital = batch(&[("feed", 10.0)], &[("feed", 8.0)], &[]);
        let no_return = batch(&[("feed", 10.0)], &[], &[]);

        assert_eq!(
            batch_maximum_cycles_for_stock(&base, "planet-a", &working_capital, &quantum),
            3.0
        );
        assert_eq!(
            batch_maximum_cycles_for_stock(&base, "planet-a", &no_return, &quantum),
            1.0
        );
    }

    #[test]
    fn direct_quantum_batch_preserves_working_capital_and_is_atomic_when_underfunded() {
        let mut base = object(json!({
            "activePlanetId": "planet-a",
            "tray": { "feed": 2 },
            "planetTrays": {},
            "planetTrayItemLimits": { "planet-a": 1_000_000 },
            "construction": { "widget": 0 },
            "portableFleet": {},
            "totalProduced": { "intermediate": 0 },
        }));
        let mut automation = object(json!({
            "quantumSourceEnabled": true,
            "destroyedByproducts": {},
            "totalCrafted": 0,
        }));
        let mut buffers = object(json!({ "center-a": { "feed": 12 } }));
        let target = crate::construction_planner::Target {
            index: 0,
            id: "widget".to_owned(),
            output_amount: 1.0,
            required_tech_id: None,
            kind: TargetKind::Building,
        };
        let working_capital = batch(
            &[("feed", 10.0)],
            &[("feed", 8.0)],
            &[("intermediate", 2.0)],
        );

        let before_base = base.clone();
        let before_automation = automation.clone();
        let before_buffers = buffers.clone();
        assert_eq!(
            apply_repeatable_batch(
                &mut base,
                &mut automation,
                &mut buffers,
                "center-a",
                "planet-a",
                &target,
                &working_capital,
                4.0,
            )
            .expect("underfunded batch should be rejected without mutation"),
            0.0
        );
        assert_eq!(base, before_base);
        assert_eq!(automation, before_automation);
        assert_eq!(buffers, before_buffers);

        assert_eq!(
            apply_repeatable_batch(
                &mut base,
                &mut automation,
                &mut buffers,
                "center-a",
                "planet-a",
                &target,
                &working_capital,
                3.0,
            )
            .expect("funded direct batch"),
            3.0
        );
        assert_eq!(
            tray(&base, "planet-a").map(|tray| inventory_amount(tray, "feed")),
            Some(8.0)
        );
        assert!(buffers.get("center-a").is_none());
        assert_eq!(
            base.get("construction")
                .and_then(Value::as_object)
                .map(|inventory| inventory_amount(inventory, "widget")),
            Some(3.0)
        );
        assert_eq!(
            base.get("totalProduced")
                .and_then(Value::as_object)
                .map(|inventory| inventory_amount(inventory, "intermediate")),
            Some(6.0)
        );
        assert_eq!(finite_number(automation.get("totalCrafted")), 3.0);
    }

    #[test]
    fn composed_byproduct_cycle_has_exact_external_cost_and_phase_guard() {
        let first = batch(&[("ore", 5.0)], &[("catalyst", 2.0)], &[("part", 1.0)]);
        let second = batch(
            &[("ore", 3.0), ("catalyst", 2.0)],
            &[("ore", 1.0)],
            &[("part", 2.0)],
        );
        let mut cycle = compose_repeatable_batches(&first, &second);
        cycle.cycle_state_items = vec!["catalyst".to_owned()];
        cycle
            .cycle_start_inventory
            .insert("catalyst".to_owned(), 0.0);
        let mut base = object(json!({
            "activePlanetId": "planet-a",
            "tray": { "ore": 100, "catalyst": 0 },
            "planetTrays": {},
            "planetTrayItemLimits": { "planet-a": 1_000_000 },
            "construction": { "widget": 0 },
            "portableFleet": {},
            "totalProduced": { "part": 0 },
        }));

        assert_eq!(cycle.jobs_per_cycle, 2);
        assert_eq!(cycle.work_seconds, 2.0);
        assert_eq!(cycle.tray_costs.get("ore"), Some(&8.0));
        assert_eq!(cycle.tray_returns.get("ore"), Some(&1.0));
        assert!(!cycle.tray_costs.contains_key("catalyst"));
        assert!(!cycle.tray_returns.contains_key("catalyst"));
        assert_eq!(cycle.produced_items.get("part"), Some(&3.0));
        assert!(batch_can_repeat(&base, "planet-a", &cycle));
        assert!(construction_cycle_state_matches(&base, "planet-a", &cycle));

        let mut applied = base.clone();
        let mut automation = object(json!({
            "quantumSourceEnabled": false,
            "destroyedByproducts": {},
            "totalCrafted": 0,
        }));
        let mut buffers = Map::new();
        let target = crate::construction_planner::Target {
            index: 0,
            id: "widget".to_owned(),
            output_amount: 1.0,
            required_tech_id: None,
            kind: TargetKind::Building,
        };
        assert_eq!(
            apply_repeatable_batch(
                &mut applied,
                &mut automation,
                &mut buffers,
                "center-a",
                "planet-a",
                &target,
                &cycle,
                3.0,
            )
            .expect("stable cycle batch"),
            6.0
        );
        assert_eq!(
            tray(&applied, "planet-a").map(|tray| inventory_amount(tray, "ore")),
            Some(79.0)
        );
        assert_eq!(
            applied
                .get("construction")
                .and_then(Value::as_object)
                .map(|inventory| inventory_amount(inventory, "widget")),
            Some(6.0)
        );
        assert_eq!(
            applied
                .get("totalProduced")
                .and_then(Value::as_object)
                .map(|inventory| inventory_amount(inventory, "part")),
            Some(9.0)
        );

        let mut direct_cache = HashMap::from([(
            "widget".to_owned(),
            ResolvedConstructionPlan {
                plan: crate::construction_planner::Plan {
                    steps: Vec::new(),
                    decisions: Vec::new(),
                },
                batch: Some(cycle.clone()),
            },
        )]);
        let direct_buffers =
            Map::from_iter([("center-a".to_owned(), json!({ "direct-marker": 1 }))]);
        assert!(
            take_valid_direct_cached_plan(
                &mut direct_cache,
                "widget",
                &base,
                &direct_buffers,
                "center-a",
                "planet-a",
            )
            .is_some()
        );

        set_inventory_amount(
            tray_mut(&mut base, "planet-a").expect("planet tray"),
            "catalyst",
            1.0,
        )
        .expect("set cycle phase");
        assert!(!construction_cycle_state_matches(&base, "planet-a", &cycle));
        assert!(
            take_valid_direct_cached_plan(
                &mut direct_cache,
                "widget",
                &base,
                &direct_buffers,
                "center-a",
                "planet-a",
            )
            .is_none()
        );
        assert!(
            direct_cache.is_empty(),
            "an invalid phase must evict the cached plan"
        );

        let mut rebuilt_cycle = cycle;
        rebuilt_cycle
            .cycle_start_inventory
            .insert("catalyst".to_owned(), 1.0);
        direct_cache.insert(
            "widget".to_owned(),
            ResolvedConstructionPlan {
                plan: crate::construction_planner::Plan {
                    steps: Vec::new(),
                    decisions: Vec::new(),
                },
                batch: Some(rebuilt_cycle),
            },
        );
        assert!(
            take_valid_direct_cached_plan(
                &mut direct_cache,
                "widget",
                &base,
                &direct_buffers,
                "center-a",
                "planet-a",
            )
            .is_some()
        );
    }
}
