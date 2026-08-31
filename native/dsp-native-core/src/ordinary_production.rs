use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;

use serde_json::Value;

use crate::state::CoreState;

const ACTIVE_DENSE_NUMERATOR: usize = 3;
const ACTIVE_DENSE_DENOMINATOR: usize = 4;
const UNKNOWN_GRID_SLOT: usize = usize::MAX;

/// Session-only deterministic wake index for built-in local machines and
/// resource veins. Persisted records remain authoritative; this directory is
/// rebuilt after commands/topology changes and is installed only with a fully
/// committed simulation candidate.
///
/// Matrix research and Dyson launch recipes deliberately remain in
/// `always_machine_indices`: their global barriers and shared base writes are
/// ordered by persisted row and are outside this independently closed slice.
#[derive(Debug, Clone)]
pub(crate) struct OrdinaryProductionRuntime {
    topology_identity: usize,
    entity_count: usize,
    total_rows: usize,
    supported_machine_indices: Vec<usize>,
    supported_vein_indices: Vec<usize>,
    always_machine_indices: Vec<usize>,
    positive_vein_grid_slots: HashMap<usize, usize>,
    positive_vein_totals_by_grid: Vec<u64>,
    awake_machine_indices: BTreeSet<usize>,
    awake_vein_indices: BTreeSet<usize>,
    wake_all: bool,
    directory_fallback: bool,
    #[cfg(test)]
    force_full_scan: bool,
    #[cfg(test)]
    scan_history: Vec<OrdinaryProductionScan>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct OrdinaryProductionScan {
    pub selected_rows: usize,
    pub total_rows: usize,
    pub stable_rows_skipped: usize,
    pub dense_fallback: bool,
    pub directory_fallback: bool,
    pub full_scan: bool,
}

#[derive(Debug)]
pub(crate) struct OrdinaryProductionSelection {
    pub machine_indices: Vec<usize>,
    pub vein_indices: Vec<usize>,
    pub dormant_positive_veins_by_grid: Vec<u64>,
    pub scan: OrdinaryProductionScan,
    pub(crate) selected_supported_machine_indices: Vec<usize>,
    pub(crate) selected_supported_vein_indices: Vec<usize>,
    fallback_detected: bool,
}

impl OrdinaryProductionRuntime {
    pub(crate) fn build(state: &CoreState, entities: &[Value]) -> Self {
        let machine_indices = &state.factory_topology.ordinary_machine_indices;
        let vein_indices = &state.factory_topology.vein_indices;
        let topology_identity = Arc::as_ptr(&state.factory_topology) as usize;
        let total_rows = machine_indices.len().saturating_add(vein_indices.len());
        let grid_count = state.catalog.planets.len().saturating_mul(3);
        let mut supported_machine_indices = Vec::new();
        let mut always_machine_indices = Vec::new();
        let mut supported_vein_indices = Vec::new();
        let mut positive_vein_grid_slots = HashMap::new();
        let mut positive_vein_totals_by_grid = vec![0_u64; grid_count];

        let mut directory_fallback = state.identity.registry_fingerprint
            != crate::command::EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT
            || state.catalog.snapshot.registry_fingerprint
                != crate::command::EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT
            || entities.len() != state.entities.ids.len()
            || machine_indices.windows(2).any(|pair| pair[0] >= pair[1])
            || vein_indices.windows(2).any(|pair| pair[0] >= pair[1]);

        for &entity_index in machine_indices {
            let valid = validate_machine_identity(state, entities, entity_index);
            directory_fallback |= !valid;
            let recipe_id = state
                .symbols
                .resolve(state.entities.recipes[entity_index])
                .unwrap_or_default();
            if is_closed_local_recipe(recipe_id) {
                supported_machine_indices.push(entity_index);
            } else {
                always_machine_indices.push(entity_index);
            }
        }
        for &entity_index in vein_indices {
            directory_fallback |= !validate_vein_identity(state, entities, entity_index);
            supported_vein_indices.push(entity_index);
            if state.entities.miner_counts[entity_index] > 0.0 {
                let planet = state.factory_topology.entity_planet_indices[entity_index];
                let grid = state.factory_topology.entity_grid_indices[entity_index];
                let slot = planet
                    .checked_mul(3)
                    .and_then(|offset| offset.checked_add(grid))
                    .filter(|&slot| slot < grid_count)
                    .unwrap_or(UNKNOWN_GRID_SLOT);
                if slot == UNKNOWN_GRID_SLOT {
                    directory_fallback = true;
                } else {
                    positive_vein_grid_slots.insert(entity_index, slot);
                    positive_vein_totals_by_grid[slot] += 1;
                }
            }
        }

        supported_machine_indices.shrink_to_fit();
        supported_vein_indices.shrink_to_fit();
        always_machine_indices.shrink_to_fit();
        let awake_machine_indices = supported_machine_indices.iter().copied().collect();
        let awake_vein_indices = supported_vein_indices.iter().copied().collect();
        Self {
            topology_identity,
            entity_count: entities.len(),
            total_rows,
            supported_machine_indices,
            supported_vein_indices,
            always_machine_indices,
            positive_vein_grid_slots,
            positive_vein_totals_by_grid,
            awake_machine_indices,
            awake_vein_indices,
            // The first pass is the exact legacy normalization/error oracle.
            wake_all: true,
            directory_fallback,
            #[cfg(test)]
            force_full_scan: false,
            #[cfg(test)]
            scan_history: Vec::new(),
        }
    }

    pub(crate) fn estimated_bytes(&self) -> u64 {
        let index_words = self.supported_machine_indices.capacity()
            + self.supported_vein_indices.capacity()
            + self.always_machine_indices.capacity()
            + self.positive_vein_totals_by_grid.capacity();
        let tree_words = (self.awake_machine_indices.len() + self.awake_vein_indices.len()) * 4;
        let map_words = self.positive_vein_grid_slots.capacity() * 4;
        (std::mem::size_of::<Self>()
            + (index_words + tree_words + map_words) * std::mem::size_of::<usize>()) as u64
    }

    pub(crate) fn wake_from_changed_entities(&mut self, changed: &[usize]) {
        if self.directory_fallback || self.wake_all || self.total_rows == 0 {
            return;
        }
        for &entity_index in changed {
            if entity_index >= self.entity_count {
                self.directory_fallback = true;
                self.wake_all = true;
                self.awake_machine_indices.clear();
                self.awake_vein_indices.clear();
                return;
            }
            if self
                .supported_machine_indices
                .binary_search(&entity_index)
                .is_ok()
            {
                self.awake_machine_indices.insert(entity_index);
            } else if self
                .supported_vein_indices
                .binary_search(&entity_index)
                .is_ok()
            {
                self.awake_vein_indices.insert(entity_index);
            }
        }
    }

    pub(crate) fn wake_from_output_credits(&mut self, active_source_items: &[(u32, u32)]) {
        if self.directory_fallback || self.wake_all || self.total_rows == 0 {
            return;
        }
        for &(entity_index, _) in active_source_items {
            self.wake_from_changed_entities(&[entity_index as usize]);
            if self.directory_fallback {
                return;
            }
        }
    }

    pub(crate) fn select(
        &self,
        state: &CoreState,
        entities: &[Value],
        global_dependency_full_scan: bool,
    ) -> OrdinaryProductionSelection {
        let topology_changed = self.topology_identity
            != Arc::as_ptr(&state.factory_topology) as usize
            || self.entity_count != entities.len()
            || self.total_rows
                != state
                    .factory_topology
                    .ordinary_machine_indices
                    .len()
                    .saturating_add(state.factory_topology.vein_indices.len());
        let selected_identity_changed = !topology_changed
            && (self
                .awake_machine_indices
                .iter()
                .chain(self.always_machine_indices.iter())
                .any(|&index| !validate_machine_identity(state, entities, index))
                || self
                    .awake_vein_indices
                    .iter()
                    .any(|&index| !validate_vein_identity(state, entities, index)));
        let fallback_detected = topology_changed || selected_identity_changed;
        let active_rows = self
            .awake_machine_indices
            .len()
            .saturating_add(self.awake_vein_indices.len())
            .saturating_add(self.always_machine_indices.len());
        let dense_fallback = !self.directory_fallback
            && !fallback_detected
            && !self.wake_all
            && active_rows > 0
            && active_rows.saturating_mul(ACTIVE_DENSE_DENOMINATOR)
                >= self.total_rows.saturating_mul(ACTIVE_DENSE_NUMERATOR);
        #[cfg(test)]
        let forced = self.force_full_scan;
        #[cfg(not(test))]
        let forced = false;
        let full_scan = forced
            || global_dependency_full_scan
            || self.directory_fallback
            || fallback_detected
            || self.wake_all
            || dense_fallback;

        let (
            machine_indices,
            vein_indices,
            selected_supported_machine_indices,
            selected_supported_vein_indices,
        ) = if full_scan {
            (
                state.factory_topology.ordinary_machine_indices.clone(),
                state.factory_topology.vein_indices.clone(),
                self.supported_machine_indices.clone(),
                self.supported_vein_indices.clone(),
            )
        } else {
            (
                merge_sorted(
                    self.awake_machine_indices.iter().copied(),
                    self.always_machine_indices.iter().copied(),
                ),
                self.awake_vein_indices.iter().copied().collect(),
                self.awake_machine_indices.iter().copied().collect(),
                self.awake_vein_indices.iter().copied().collect(),
            )
        };

        let mut dormant_positive_veins_by_grid = if full_scan {
            vec![0; self.positive_vein_totals_by_grid.len()]
        } else {
            self.positive_vein_totals_by_grid.clone()
        };
        if !full_scan {
            for entity_index in &selected_supported_vein_indices {
                if let Some(&slot) = self.positive_vein_grid_slots.get(entity_index) {
                    dormant_positive_veins_by_grid[slot] =
                        dormant_positive_veins_by_grid[slot].saturating_sub(1);
                }
            }
        }
        let selected_rows = machine_indices.len().saturating_add(vein_indices.len());
        OrdinaryProductionSelection {
            machine_indices,
            vein_indices,
            dormant_positive_veins_by_grid,
            scan: OrdinaryProductionScan {
                selected_rows,
                total_rows: self.total_rows,
                stable_rows_skipped: self.total_rows.saturating_sub(selected_rows),
                dense_fallback,
                directory_fallback: self.directory_fallback || fallback_detected,
                full_scan,
            },
            selected_supported_machine_indices,
            selected_supported_vein_indices,
            fallback_detected,
        }
    }

    /// Atomically advances the wake set after every selected row has settled
    /// successfully. The two readiness slices must be in the exact selected
    /// supported-row order. Validation completes before either live set is
    /// replaced, so a failed candidate retains its prior wakes.
    pub(crate) fn commit_selection(
        &mut self,
        selection: OrdinaryProductionSelection,
        machine_awake: &[(usize, bool)],
        vein_awake: &[(usize, bool)],
    ) -> anyhow::Result<OrdinaryProductionScan> {
        validate_readiness(
            &selection.selected_supported_machine_indices,
            machine_awake,
            "machine",
        )?;
        validate_readiness(
            &selection.selected_supported_vein_indices,
            vein_awake,
            "vein",
        )?;
        let mut next_machines = self.awake_machine_indices.clone();
        let mut next_veins = self.awake_vein_indices.clone();
        for &(entity_index, awake) in machine_awake {
            if awake {
                next_machines.insert(entity_index);
            } else {
                next_machines.remove(&entity_index);
            }
        }
        for &(entity_index, awake) in vein_awake {
            if awake {
                next_veins.insert(entity_index);
            } else {
                next_veins.remove(&entity_index);
            }
        }
        self.awake_machine_indices = next_machines;
        self.awake_vein_indices = next_veins;
        self.wake_all = false;
        self.directory_fallback |= selection.fallback_detected;
        #[cfg(test)]
        self.scan_history.push(selection.scan);
        Ok(selection.scan)
    }

    #[cfg(test)]
    pub(crate) fn force_full_scan_for_test(&mut self, force: bool) {
        self.force_full_scan = force;
    }

    #[cfg(test)]
    pub(crate) fn scan_history_for_test(&self) -> &[OrdinaryProductionScan] {
        &self.scan_history
    }

    #[cfg(test)]
    pub(crate) fn pending_rows_for_test(&self) -> (Vec<usize>, Vec<usize>) {
        (
            self.awake_machine_indices.iter().copied().collect(),
            self.awake_vein_indices.iter().copied().collect(),
        )
    }
}

fn validate_readiness(
    expected: &[usize],
    observed: &[(usize, bool)],
    domain: &str,
) -> anyhow::Result<()> {
    if expected.len() != observed.len()
        || expected
            .iter()
            .zip(observed)
            .any(|(&expected, &(observed, _))| expected != observed)
    {
        anyhow::bail!("native ordinary production {domain} readiness order diverged");
    }
    Ok(())
}

fn is_closed_local_recipe(recipe_id: &str) -> bool {
    !matches!(
        recipe_id,
        "matrix_research" | "solar_sail_launch" | "carrier_rocket_launch"
    )
}

fn validate_machine_identity(state: &CoreState, entities: &[Value], index: usize) -> bool {
    let Some(entity) = entities.get(index).and_then(Value::as_object) else {
        return false;
    };
    !entity.keys().any(|key| key.starts_with("mod:"))
        && entity.get("id").and_then(Value::as_str) == Some(&state.entities.ids[index])
        && entity.get("kind").and_then(Value::as_str) == Some("machine")
        && entity
            .get("buildingId")
            .and_then(Value::as_str)
            .is_some_and(|id| !id.contains(':'))
        && entity
            .get("recipeId")
            .and_then(Value::as_str)
            .is_some_and(|id| !id.contains(':'))
        && entity.get("buildingId").and_then(Value::as_str)
            == state
                .entities
                .buildings
                .get(index)
                .and_then(|symbol| state.symbols.resolve(*symbol))
        && entity.get("recipeId").and_then(Value::as_str)
            == state
                .entities
                .recipes
                .get(index)
                .and_then(|symbol| state.symbols.resolve(*symbol))
}

fn validate_vein_identity(state: &CoreState, entities: &[Value], index: usize) -> bool {
    let Some(entity) = entities.get(index).and_then(Value::as_object) else {
        return false;
    };
    !entity.keys().any(|key| key.starts_with("mod:"))
        && entity.get("id").and_then(Value::as_str) == Some(&state.entities.ids[index])
        && entity.get("kind").and_then(Value::as_str) == Some("vein")
        && entity
            .get("resourceId")
            .and_then(Value::as_str)
            .is_some_and(|id| !id.contains(':'))
        && entity.get("resourceId").and_then(Value::as_str)
            == state
                .entities
                .resources
                .get(index)
                .and_then(|symbol| state.symbols.resolve(*symbol))
}

fn merge_sorted(
    left: impl Iterator<Item = usize>,
    right: impl Iterator<Item = usize>,
) -> Vec<usize> {
    let mut left = left.peekable();
    let mut right = right.peekable();
    let mut merged = Vec::new();
    while left.peek().is_some() || right.peek().is_some() {
        match (left.peek().copied(), right.peek().copied()) {
            (Some(a), Some(b)) if a <= b => {
                merged.push(a);
                left.next();
                if a == b {
                    right.next();
                }
            }
            (Some(_), Some(b)) => {
                merged.push(b);
                right.next();
            }
            (Some(a), None) => {
                merged.push(a);
                left.next();
            }
            (None, Some(b)) => {
                merged.push(b);
                right.next();
            }
            (None, None) => break,
        }
    }
    merged
}

pub(crate) fn merge_settlement_indices(
    power_source_indices: &[usize],
    selection: &OrdinaryProductionSelection,
) -> Vec<usize> {
    let production = merge_sorted(
        selection.machine_indices.iter().copied(),
        selection.vein_indices.iter().copied(),
    );
    merge_sorted(power_source_indices.iter().copied(), production.into_iter())
}
