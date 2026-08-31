use std::collections::BTreeSet;
use std::sync::Arc;

use anyhow::bail;
use serde_json::Value;

use crate::state::CoreState;

const ACTIVE_DENSE_NUMERATOR: usize = 3;
const ACTIVE_DENSE_DENOMINATOR: usize = 4;

/// Session-only deterministic wake queue for built-in material-delivery hubs.
/// Persisted entity rows remain authoritative. The queue is rebuilt after a
/// command/topology change and is published only with a committed candidate.
#[derive(Debug, Clone)]
pub(crate) struct MaterialDeliveryRuntime {
    topology_identity: usize,
    entity_count: usize,
    total_rows: usize,
    pending_entity_indices: BTreeSet<usize>,
    wake_all: bool,
    directory_fallback: bool,
    #[cfg(test)]
    force_full_scan: bool,
    #[cfg(test)]
    scan_history: Vec<MaterialDeliveryScan>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct MaterialDeliveryScan {
    pub selected_rows: usize,
    pub total_rows: usize,
    pub stable_rows_skipped: usize,
    pub dense_fallback: bool,
    pub directory_fallback: bool,
    pub full_scan: bool,
}

pub(crate) struct MaterialDeliverySelection {
    pub(crate) entity_indices: Vec<usize>,
    pub(crate) scan: MaterialDeliveryScan,
    fallback_detected: bool,
}

impl MaterialDeliveryRuntime {
    pub(crate) fn build(state: &CoreState, entities: &[Value]) -> Self {
        let indices = &state.factory_topology.material_delivery_hub_indices;
        let directory_fallback = state.identity.registry_fingerprint
            != crate::command::EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT
            || state.catalog.snapshot.registry_fingerprint
                != crate::command::EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT
            || entities.len() != state.entities.ids.len()
            || indices.windows(2).any(|pair| pair[0] >= pair[1])
            || indices
                .iter()
                .any(|&index| !validate_hub_identity(state, entities, index));
        Self {
            topology_identity: Arc::as_ptr(&state.factory_topology) as usize,
            entity_count: entities.len(),
            total_rows: indices.len(),
            pending_entity_indices: BTreeSet::new(),
            // The first committed step executes both legacy drain phases for
            // every row, including their zero-field normalization.
            wake_all: true,
            directory_fallback,
            #[cfg(test)]
            force_full_scan: false,
            #[cfg(test)]
            scan_history: Vec::new(),
        }
    }

    pub(crate) fn estimated_bytes(&self) -> u64 {
        (std::mem::size_of::<Self>()
            + self.pending_entity_indices.len() * std::mem::size_of::<usize>() * 4) as u64
    }

    pub(crate) fn wake_from_changed_entities(&mut self, state: &CoreState, changed: &[usize]) {
        if self.directory_fallback || self.wake_all || self.total_rows == 0 {
            return;
        }
        let indices = &state.factory_topology.material_delivery_hub_indices;
        if self.topology_identity != Arc::as_ptr(&state.factory_topology) as usize
            || self.entity_count != state.entities.ids.len()
            || self.total_rows != indices.len()
        {
            self.directory_fallback = true;
            self.wake_all = true;
            self.pending_entity_indices.clear();
            return;
        }
        for &entity_index in changed {
            if entity_index >= self.entity_count {
                self.directory_fallback = true;
                self.wake_all = true;
                self.pending_entity_indices.clear();
                return;
            }
            if indices.binary_search(&entity_index).is_ok() {
                self.pending_entity_indices.insert(entity_index);
            }
        }
    }

    pub(crate) fn select(
        &self,
        state: &CoreState,
        entities: &[Value],
    ) -> MaterialDeliverySelection {
        let indices = &state.factory_topology.material_delivery_hub_indices;
        let topology_changed = self.topology_identity
            != Arc::as_ptr(&state.factory_topology) as usize
            || self.entity_count != entities.len()
            || self.total_rows != indices.len();
        #[cfg(test)]
        let forced = self.force_full_scan;
        #[cfg(not(test))]
        let forced = false;
        let identity_probe_all = self.directory_fallback || self.wake_all || forced;
        let selected_identity_changed = !topology_changed
            && if identity_probe_all {
                indices
                    .iter()
                    .any(|&index| !validate_hub_identity(state, entities, index))
            } else {
                self.pending_entity_indices
                    .iter()
                    .any(|&index| !validate_hub_identity(state, entities, index))
            };
        let fallback_detected = topology_changed || selected_identity_changed;
        let active = self.pending_entity_indices.len();
        let dense_fallback = !self.directory_fallback
            && !fallback_detected
            && !self.wake_all
            && active > 0
            && active.saturating_mul(ACTIVE_DENSE_DENOMINATOR)
                >= self.total_rows.saturating_mul(ACTIVE_DENSE_NUMERATOR);
        let full_scan = forced
            || self.directory_fallback
            || fallback_detected
            || self.wake_all
            || dense_fallback;
        let entity_indices = if full_scan {
            indices.clone()
        } else {
            self.pending_entity_indices.iter().copied().collect()
        };
        let selected_rows = entity_indices.len();
        MaterialDeliverySelection {
            entity_indices,
            scan: MaterialDeliveryScan {
                selected_rows,
                total_rows: self.total_rows,
                stable_rows_skipped: self.total_rows.saturating_sub(selected_rows),
                dense_fallback,
                directory_fallback: self.directory_fallback || fallback_detected,
                full_scan,
            },
            fallback_detected,
        }
    }

    /// Every row selected by the pre-production drain must run again after the
    /// late output-belt transfer. This preserves the legacy second-phase reset
    /// of utilization/progress/rate even when the first phase emptied the hub.
    pub(crate) fn commit_first_phase(
        &mut self,
        selection: MaterialDeliverySelection,
    ) -> MaterialDeliveryScan {
        for entity_index in &selection.entity_indices {
            self.pending_entity_indices.insert(*entity_index);
        }
        self.wake_all = false;
        self.directory_fallback |= selection.fallback_detected;
        #[cfg(test)]
        self.scan_history.push(selection.scan);
        selection.scan
    }

    /// Applies post-second-drain readiness atomically. Validation precedes the
    /// set replacement so a failed candidate retains every source wake.
    pub(crate) fn commit_second_phase(
        &mut self,
        selection: MaterialDeliverySelection,
        stay_awake: &[(usize, bool)],
    ) -> anyhow::Result<MaterialDeliveryScan> {
        if selection.entity_indices.len() != stay_awake.len()
            || selection
                .entity_indices
                .iter()
                .zip(stay_awake)
                .any(|(&expected, &(observed, _))| expected != observed)
        {
            bail!("native material delivery readiness order diverged");
        }
        let mut next = self.pending_entity_indices.clone();
        for &(entity_index, awake) in stay_awake {
            if awake {
                next.insert(entity_index);
            } else {
                next.remove(&entity_index);
            }
        }
        self.pending_entity_indices = next;
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
    pub(crate) fn pending_rows_for_test(&self) -> Vec<usize> {
        self.pending_entity_indices.iter().copied().collect()
    }

    #[cfg(test)]
    pub(crate) fn scan_history_for_test(&self) -> &[MaterialDeliveryScan] {
        &self.scan_history
    }
}

fn validate_hub_identity(state: &CoreState, entities: &[Value], index: usize) -> bool {
    let Some(entity) = entities.get(index).and_then(Value::as_object) else {
        return false;
    };
    !entity.keys().any(|key| key.starts_with("mod:"))
        && entity.get("id").and_then(Value::as_str) == Some(&state.entities.ids[index])
        && entity.get("kind").and_then(Value::as_str) == Some("storage")
        && entity.get("buildingId").and_then(Value::as_str) == Some("material_delivery_hub")
        && state
            .entities
            .buildings
            .get(index)
            .and_then(|symbol| state.symbols.resolve(*symbol))
            == Some("material_delivery_hub")
        && entity.get("planetId").and_then(Value::as_str)
            == state
                .entities
                .planets
                .get(index)
                .and_then(|symbol| state.symbols.resolve(*symbol))
}
