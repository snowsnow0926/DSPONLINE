use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;
use std::mem::size_of;
use std::sync::{Arc, Mutex};

use anyhow::{Context, anyhow, bail};
use num_bigint::BigUint;
use serde::Serialize;
use serde_json::value::RawValue;
use serde_json::{Deserializer, Map, Number, Value};

use crate::deterministic_runtime::{DeterministicRuntime, runtime as deterministic_runtime};
use crate::state::{
    BELT_DYNAMIC_PAGE_ROWS, BeltCommitSource, BeltDynamicColumns, BeltPagedColumn, CoreState,
    ExactRowIds, RawRecord,
};

const EPSILON: f64 = 0.0001;
const SOURCE_SNAPSHOT_ROWS_PER_CHUNK: usize = 1_024;
const TARGET_CAPACITY_ROWS_PER_CHUNK: usize = 1_024;
const EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT: &str = "7df8cf3a";

#[inline]
fn persisted_belt_dimensions(belt: &Map<String, Value>) -> (f64, f64) {
    // v47 historically treats an omitted `lanes` field as one lane. The
    // compact startup column uses zero for a missing numeric field, so any
    // path that needs persisted capacity must read this default from the raw
    // record instead of silently turning a valid legacy belt into capacity 0.
    let lanes = belt
        .get("lanes")
        .map(|value| finite_number(Some(value)))
        .unwrap_or(1.0)
        .floor();
    let stack_size = finite_number(belt.get("stackSize")).max(1.0).floor();
    (lanes, stack_size)
}

#[derive(Debug, Clone)]
pub(crate) struct BeltRawPatch {
    index: usize,
    raw: RawRecord,
}

impl BeltRawPatch {
    pub(crate) fn into_parts(self) -> (usize, RawRecord) {
        (self.index, self.raw)
    }
}

#[derive(Debug)]
struct BeltCommitSeal {
    source: BeltCommitSource,
    patches: Arc<Vec<BeltRawPatch>>,
    dynamics: Option<Arc<BeltDynamicColumns>>,
}

/// A belt write-back that can only be produced after `BeltRuntime` has
/// validated the complete runtime topology and dynamic columns against one
/// exact source revision. The duplicated Arc handles are an immutable seal:
/// any test-only or future in-crate replacement of patches/dynamics breaks
/// pointer identity and fails before the transactional candidate is built.
#[derive(Debug)]
pub(crate) struct BeltCommitBatch {
    patches: Arc<Vec<BeltRawPatch>>,
    dynamics: Option<Arc<BeltDynamicColumns>>,
    seal: BeltCommitSeal,
}

#[derive(Debug)]
pub(crate) struct ValidatedBeltCommit {
    patches: Vec<BeltRawPatch>,
    dynamics: Option<BeltDynamicColumns>,
}

impl ValidatedBeltCommit {
    pub(crate) fn into_parts(self) -> (Vec<BeltRawPatch>, Option<BeltDynamicColumns>) {
        (self.patches, self.dynamics)
    }
}

impl BeltCommitBatch {
    fn seal(
        source: BeltCommitSource,
        patches: Vec<BeltRawPatch>,
        dynamics: Option<BeltDynamicColumns>,
    ) -> Self {
        let patches = Arc::new(patches);
        let dynamics = dynamics.map(Arc::new);
        Self {
            seal: BeltCommitSeal {
                source,
                patches: patches.clone(),
                dynamics: dynamics.clone(),
            },
            patches,
            dynamics,
        }
    }

    pub(crate) fn unseal(self, state: &CoreState) -> anyhow::Result<ValidatedBeltCommit> {
        let patches_sealed = Arc::ptr_eq(&self.patches, &self.seal.patches);
        let dynamics_sealed = match (&self.dynamics, &self.seal.dynamics) {
            (None, None) => true,
            (Some(actual), Some(sealed)) => Arc::ptr_eq(actual, sealed),
            _ => false,
        };
        if !patches_sealed || !dynamics_sealed || !self.seal.source.matches(state) {
            bail!("native belt commit batch seal is invalid");
        }

        let Self {
            patches,
            dynamics,
            seal,
        } = self;
        drop(seal);
        let patches = Arc::try_unwrap(patches)
            .map_err(|_| anyhow!("native belt commit patch ownership is invalid"))?;
        let dynamics = dynamics
            .map(|dynamics| {
                Arc::try_unwrap(dynamics)
                    .map_err(|_| anyhow!("native belt commit dynamics ownership is invalid"))
            })
            .transpose()?;
        Ok(ValidatedBeltCommit { patches, dynamics })
    }

    /// Seals an explicit no-op belt write-back for a domain-only state
    /// transaction. The caller still has to publish through
    /// `CoreState::commit_simulated_state`, whose source/revision checks make
    /// the batch unusable after any intervening belt or state commit.
    pub(crate) fn unchanged(state: &CoreState) -> anyhow::Result<Self> {
        state.validate_belt_runtime_topology()?;
        Ok(Self::seal(state.belt_commit_source(), Vec::new(), None))
    }

    #[cfg(test)]
    pub(crate) fn unchanged_for_test(state: &CoreState) -> Self {
        Self::seal(state.belt_commit_source(), Vec::new(), None)
    }

    #[cfg(test)]
    pub(crate) fn from_dynamics_for_test(
        state: &CoreState,
        dynamics: BeltDynamicColumns,
    ) -> anyhow::Result<Self> {
        let runtime = BeltRuntime::from_dynamics_for_test(state, dynamics)?;
        runtime
            .into_patches(state, BeltFlowRequirement::ExactOriginalOrder)
            .map(|(batch, _, _)| batch)
    }

    #[cfg(test)]
    pub(crate) fn forged_for_test(
        state: &CoreState,
        patches: Vec<(usize, RawRecord)>,
        dynamics: BeltDynamicColumns,
    ) -> Self {
        let mut batch = Self::seal(state.belt_commit_source(), Vec::new(), None);
        batch.patches = Arc::new(
            patches
                .into_iter()
                .map(|(index, raw)| BeltRawPatch { index, raw })
                .collect(),
        );
        batch.dynamics = Some(Arc::new(dynamics));
        batch
    }

    #[cfg(test)]
    pub(crate) fn patch_count(&self) -> usize {
        self.patches.len()
    }

    #[cfg(test)]
    pub(crate) fn patch_indices(&self) -> Vec<usize> {
        self.patches.iter().map(|patch| patch.index).collect()
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct BeltFlowAggregate {
    pub capacity: f64,
    pub flow: f64,
}

/// Whether this revision's production-history boundary will consume the
/// logistics aggregate. Skipped revisions must not perform the O(B) float
/// fold; exact revisions retain the historical persisted-row order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BeltFlowRequirement {
    NotRequired,
    ExactOriginalOrder,
}

#[derive(Debug, Clone, Copy)]
pub(crate) enum PreparedBeltFlow {
    NotRequired,
    Exact(BeltFlowAggregate),
}

#[derive(Debug, Default)]
pub(crate) struct OutputCredits {
    group_by_key: Arc<HashMap<(u32, u32), u32>>,
    /// Sparse by construction: absent groups have zero credit. This avoids a
    /// factory-sized fill on every exact second when only a small active
    /// frontier can consume reserved belt capacity.
    by_group: HashMap<u32, f64>,
    /// Stable compact source/item keys for positive credits. Quantum demand
    /// wake-up can therefore consume only this active frontier without
    /// reversing the full prepared group map at every five-second boundary.
    active_source_items: Vec<(u32, u32)>,
}

impl OutputCredits {
    #[inline]
    fn get(&self, source_index: usize, item_symbol: u32) -> f64 {
        let Ok(source_index) = u32::try_from(source_index) else {
            return 0.0;
        };
        self.group_by_key
            .get(&(source_index, item_symbol))
            .and_then(|group_index| self.by_group.get(group_index))
            .copied()
            .unwrap_or(0.0)
    }

    pub(crate) fn active_source_items(&self) -> &[(u32, u32)] {
        &self.active_source_items
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BeltSchedulerDiagnostics {
    pub route_count: usize,
    pub group_count: usize,
    pub active_queue_enabled: bool,
    /// Route groups inspected while building the one-time activity seed for a
    /// topology. A carried snapshot keeps this at zero on later revisions.
    pub initialization_group_checks: u64,
    /// Route groups visited by active selection. Sparse revisions must scale
    /// with the carried/woken set rather than with `group_count`.
    pub selection_group_checks: u64,
    /// Number of groups restored from the previous committed revision.
    pub carried_active_groups: usize,
    pub transfer_passes: u64,
    pub reservation_passes: u64,
    pub full_scan_passes: u64,
    pub transfer_route_checks: u64,
    pub reservation_route_checks: u64,
    pub reservation_allowance_entries: usize,
    pub reservation_credit_entries: usize,
    /// Sum, across transfer and reservation passes, of topology routes omitted
    /// from the captured selection. A newly reverse-woken ordinary producer
    /// may still receive one bounded clock catch-up after that transfer pass;
    /// this is a route-scan saving counter, not a promise that every omitted
    /// route was completely untouched by the revision.
    pub stable_routes_skipped: u64,
    pub wake_count: u64,
    pub sleep_count: u64,
    pub changed_belt_records: usize,
    pub write_back_patch_records: usize,
    pub write_back_workers: usize,
    /// Test-visible accounting for the write-back evidence walk. These are
    /// deliberately excluded from the host protocol: they protect the
    /// O(active) implementation boundary without widening the renderer API.
    #[serde(skip)]
    pub(crate) write_back_flow_checks: usize,
    #[serde(skip)]
    pub(crate) write_back_evidence_checks: usize,
    /// Page-granular copy/validation evidence. These internal counters make it
    /// possible to enforce that a sparse revision scales with dirty pages,
    /// without widening the renderer protocol.
    #[serde(skip)]
    pub(crate) dynamic_cow_pages: usize,
    #[serde(skip)]
    pub(crate) mask_cow_pages: usize,
    #[serde(skip)]
    pub(crate) dirty_validation_rows: usize,
    /// A carried revision can move its factory-sized scratch buffers into the
    /// next exact transaction. These fields remain process-local evidence and
    /// never widen the host protocol or persisted v47 state.
    #[cfg(test)]
    #[serde(skip)]
    pub(crate) runtime_workspace_reused: bool,
    #[cfg(test)]
    #[serde(skip)]
    pub(crate) runtime_workspace_initialized_route_rows: usize,
    #[cfg(test)]
    #[serde(skip)]
    pub(crate) runtime_workspace_initialized_group_rows: usize,
    #[cfg(test)]
    #[serde(skip)]
    pub(crate) runtime_workspace_initialized_target_rows: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct BeltWritebackPlan {
    dense: bool,
    patch_count: usize,
    worker_count: usize,
}

fn belt_writeback_plan(
    runtime: &DeterministicRuntime,
    belt_count: usize,
    changed_count: usize,
) -> BeltWritebackPlan {
    let dense = changed_count > belt_count / 3;
    let patch_count = if dense { belt_count } else { changed_count };
    BeltWritebackPlan {
        dense,
        patch_count,
        // Sparse work deliberately stays serial even when the absolute dirty
        // count is large. Dense work uses the shared runtime's existing small
        // input threshold, so no phase creates another pool or tiny tasks.
        worker_count: if patch_count == 0 {
            0
        } else if dense {
            runtime.worker_count_for_items(patch_count)
        } else {
            1
        },
    }
}

#[derive(Debug, Default)]
pub(crate) struct BeltStepReservation {
    // Missing means that the JS reservation pass did not cap this belt. The
    // compact row index remains stable for the prepared topology; the sparse
    // map scales with the active frontier rather than all persisted belts.
    pub allowance_by_belt: HashMap<u32, f64>,
    pub output_credits: OutputCredits,
}

// Dense saves deliberately use a full scan. Represent that mode as a sentinel
// so every transfer/reservation pass avoids allocating and filling a group
// bitmap; sparse mode retains the exact per-group wake mask.
#[derive(Debug)]
enum ActiveSelection {
    All,
    Dense {
        selected_group_indices: Vec<u32>,
        selected_route_indices: Vec<u32>,
    },
    Mask {
        selected_group_indices: Vec<u32>,
        selected_route_indices: Vec<u32>,
    },
}

/// Complete in-process evidence for belt rows whose mutable columns may have
/// changed since the runtime was cloned from its exact source revision.
///
/// The sparse form is a set while simulation is running so repeated exact
/// steps cannot grow it with duplicates. Sealing converts it to a stable,
/// sorted list and rejects out-of-range evidence before write-back indexes any
/// flat column. `All` is selected only by the existing full/dense activity
/// decision; there is intentionally no additional touched-row threshold.
#[derive(Debug)]
enum TouchedRoutes {
    Sparse(HashSet<u32>),
    All,
}

impl Default for TouchedRoutes {
    fn default() -> Self {
        Self::Sparse(HashSet::new())
    }
}

#[derive(Debug)]
enum TouchedRouteEvidence {
    Sparse(Box<[u32]>),
    All,
}

#[derive(Debug)]
struct SealedTouchedRoutes {
    evidence: Arc<TouchedRouteEvidence>,
    seal: Arc<TouchedRouteEvidence>,
}

impl TouchedRoutes {
    fn record_selection(&mut self, prepared_routes: &PreparedRoutes, selection: &ActiveSelection) {
        match selection {
            ActiveSelection::All | ActiveSelection::Dense { .. } => *self = Self::All,
            ActiveSelection::Mask {
                selected_group_indices,
                ..
            } => {
                if let Self::Sparse(indices) = self {
                    for group_index in selected_group_indices.iter().copied() {
                        indices.extend(
                            prepared_routes.groups[expand_compact_index(group_index)]
                                .route_indices
                                .iter()
                                .copied(),
                        );
                    }
                }
            }
        }
    }

    fn record_index(&mut self, index: usize) -> anyhow::Result<()> {
        if let Self::Sparse(indices) = self {
            indices.insert(compact_index(index, "touched route index")?);
        }
        Ok(())
    }

    fn seal(self, belt_count: usize) -> anyhow::Result<SealedTouchedRoutes> {
        let evidence = match self {
            Self::All => TouchedRouteEvidence::All,
            Self::Sparse(indices) => {
                let mut indices = indices.into_iter().collect::<Vec<_>>();
                indices.sort_unstable();
                if indices
                    .last()
                    .is_some_and(|&index| expand_compact_index(index) >= belt_count)
                {
                    bail!("native touched belt evidence is outside the topology");
                }
                debug_assert!(indices.windows(2).all(|pair| pair[0] < pair[1]));
                TouchedRouteEvidence::Sparse(indices.into_boxed_slice())
            }
        };
        let evidence = Arc::new(evidence);
        Ok(SealedTouchedRoutes {
            seal: Arc::clone(&evidence),
            evidence,
        })
    }

    #[cfg(test)]
    fn signature(&self) -> Option<Vec<u32>> {
        match self {
            Self::All => None,
            Self::Sparse(indices) => {
                let mut indices = indices.iter().copied().collect::<Vec<_>>();
                indices.sort_unstable();
                Some(indices)
            }
        }
    }
}

impl SealedTouchedRoutes {
    fn unseal(self) -> anyhow::Result<TouchedRouteEvidence> {
        if !Arc::ptr_eq(&self.evidence, &self.seal) {
            bail!("native touched belt evidence seal is invalid");
        }
        let Self { evidence, seal } = self;
        drop(seal);
        Arc::try_unwrap(evidence)
            .map_err(|_| anyhow!("native touched belt evidence ownership is invalid"))
    }

    #[cfg(test)]
    fn forge_evidence_for_test(&mut self, evidence: TouchedRouteEvidence) {
        self.evidence = Arc::new(evidence);
    }
}

/// Runtime-only activity proof carried between consecutive native revisions.
///
/// The snapshot owns an `Arc` to the exact compiled topology, so it can never
/// be installed on a rebuilt route graph. It is deliberately absent from v47,
/// checkpoints and canonical hashes: a process restart may rebuild the same
/// seed with one bounded full topology inspection without changing gameplay.
#[derive(Debug)]
pub(crate) struct BeltActivitySnapshot {
    routes: Arc<PreparedRoutes>,
    active_group_indices: Arc<[u32]>,
    active_queue_enabled: bool,
    reusable_pool: Arc<BeltReusablePool>,
}

#[derive(Debug, Default)]
struct BeltReusablePool {
    runtime: Mutex<Option<BeltReusableRuntime>>,
}

#[derive(Debug)]
struct BeltReusableRuntime {
    active_groups: Vec<bool>,
    occupied_group_indices: Arc<[u32]>,
    workspace: BeltWorkspace,
}

impl BeltActivitySnapshot {
    fn matches_topology(&self, prepared_routes: &Arc<PreparedRoutes>) -> bool {
        Arc::ptr_eq(&self.routes, prepared_routes)
            && self
                .active_group_indices
                .iter()
                .all(|&index| expand_compact_index(index) < prepared_routes.groups.len())
            && self
                .active_group_indices
                .windows(2)
                .all(|pair| pair[0] < pair[1])
    }

    #[cfg(test)]
    fn take_reusable_runtime(&self) -> Option<BeltReusableRuntime> {
        self.reusable_pool.take()
    }

    pub(crate) fn estimated_bytes(&self) -> u64 {
        (self.active_group_indices.len() * size_of::<u32>()) as u64
            + self
                .reusable_pool
                .estimated_bytes(&self.active_group_indices)
    }
}

impl BeltReusablePool {
    fn take(&self) -> Option<BeltReusableRuntime> {
        self.runtime
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
    }

    fn put_if_empty(&self, runtime: BeltReusableRuntime) {
        let mut slot = self
            .runtime
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if slot.is_none() {
            *slot = Some(runtime);
        }
    }

    fn estimated_bytes(&self, viewing_indices: &Arc<[u32]>) -> u64 {
        self.runtime
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
            .map(|runtime| {
                runtime.estimated_bytes()
                    + if Arc::ptr_eq(&runtime.occupied_group_indices, viewing_indices) {
                        0
                    } else {
                        (runtime.occupied_group_indices.len() * size_of::<u32>()) as u64
                    }
            })
            .unwrap_or(0)
    }
}

impl BeltReusableRuntime {
    fn estimated_bytes(&self) -> u64 {
        self.active_groups.capacity().div_ceil(u8::BITS as usize) as u64
            + self.workspace.estimated_bytes()
    }
}

enum ActiveGroupIndices<'a> {
    All(std::ops::Range<usize>),
    Mask(std::slice::Iter<'a, u32>),
}

enum ActiveRouteIndices<'a> {
    All(std::ops::Range<usize>),
    Mask(std::slice::Iter<'a, u32>),
}

impl Iterator for ActiveGroupIndices<'_> {
    type Item = usize;

    fn next(&mut self) -> Option<Self::Item> {
        match self {
            Self::All(indices) => indices.next(),
            Self::Mask(indices) => indices.next().copied().map(expand_compact_index),
        }
    }
}

impl Iterator for ActiveRouteIndices<'_> {
    type Item = usize;

    fn next(&mut self) -> Option<Self::Item> {
        match self {
            Self::All(indices) => indices.next(),
            Self::Mask(indices) => indices.next().copied().map(expand_compact_index),
        }
    }
}

impl ActiveSelection {
    fn selected_groups(&self, group_count: usize) -> usize {
        match self {
            Self::All | Self::Dense { .. } => group_count,
            Self::Mask {
                selected_group_indices,
                ..
            } => selected_group_indices.len(),
        }
    }

    fn selected_routes(&self, route_count: usize) -> u64 {
        match self {
            Self::All | Self::Dense { .. } => route_count as u64,
            Self::Mask {
                selected_route_indices,
                ..
            } => selected_route_indices.len() as u64,
        }
    }

    fn group_indices(&self, group_count: usize) -> ActiveGroupIndices<'_> {
        match self {
            Self::All | Self::Dense { .. } => ActiveGroupIndices::All(0..group_count),
            Self::Mask {
                selected_group_indices,
                ..
            } => ActiveGroupIndices::Mask(selected_group_indices.iter()),
        }
    }

    fn group_index_at(&self, selected_index: usize) -> usize {
        match self {
            Self::All | Self::Dense { .. } => selected_index,
            Self::Mask {
                selected_group_indices,
                ..
            } => expand_compact_index(selected_group_indices[selected_index]),
        }
    }

    fn contains_group(&self, group_index: u32) -> bool {
        match self {
            Self::All | Self::Dense { .. } => true,
            Self::Mask {
                selected_group_indices,
                ..
            } => selected_group_indices.binary_search(&group_index).is_ok(),
        }
    }

    fn route_indices(&self, route_count: usize) -> ActiveRouteIndices<'_> {
        match self {
            Self::All | Self::Dense { .. } => ActiveRouteIndices::All(0..route_count),
            Self::Mask {
                selected_route_indices,
                ..
            } => ActiveRouteIndices::Mask(selected_route_indices.iter()),
        }
    }

    fn recycle_into(
        self,
        selected_group_indices: &mut Vec<u32>,
        selected_route_indices: &mut Vec<u32>,
    ) {
        match self {
            Self::All => {}
            Self::Dense {
                selected_group_indices: reusable_indices,
                selected_route_indices: reusable_routes,
            }
            | Self::Mask {
                selected_group_indices: reusable_indices,
                selected_route_indices: reusable_routes,
            } => {
                *selected_group_indices = reusable_indices;
                *selected_route_indices = reusable_routes;
            }
        }
    }

    fn is_full_scan(&self) -> bool {
        matches!(self, Self::All | Self::Dense { .. })
    }
}

#[derive(Debug)]
pub(crate) struct BeltRuntime {
    /// Shared scratch pool for the exact prepared topology. When armed, Drop
    /// is the transactional rollback boundary for every early `?`.
    reusable_pool: Option<Arc<BeltReusablePool>>,
    source: Option<BeltCommitSource>,
    progress: BeltPagedColumn<f64>,
    total_transferred: BeltPagedColumn<f64>,
    congestion: BeltPagedColumn<f64>,
    last_flow: BeltPagedColumn<f64>,
    total_dirty: BeltPagedColumn<bool>,
    touched_routes: TouchedRoutes,
    belt_capacity: f64,
    // Runtime-only source/item wake state. A group may sleep only when its
    // source has no cargo and every persisted belt signal is exactly idle.
    // Production and logistics are checked again at every output boundary, so
    // a sleeping group is re-admitted in the same deterministic step in which
    // cargo becomes available.
    active_groups: Vec<bool>,
    /// Sorted by prepared group index. Selection copies only this O(active)
    /// set; newly woken passive sources are inserted in stable order.
    active_group_indices: Vec<u32>,
    active_queue_enabled: bool,
    diagnostics: BeltSchedulerDiagnostics,
    workspace: BeltWorkspace,
}

impl BeltRuntime {
    #[cfg(test)]
    fn empty(belt_count: usize, prepared_routes: &PreparedRoutes) -> Self {
        Self::empty_with_reusable(belt_count, prepared_routes, None)
    }

    fn empty_with_reusable(
        belt_count: usize,
        prepared_routes: &PreparedRoutes,
        reusable: Option<BeltReusableRuntime>,
    ) -> Self {
        let group_count = prepared_routes.groups.len();
        let target_slot_count = expand_compact_index(prepared_routes.target_slot_count);
        let reusable = reusable.filter(|buffers| {
            buffers.active_groups.len() == group_count
                && buffers
                    .occupied_group_indices
                    .iter()
                    .all(|&index| expand_compact_index(index) < group_count)
                && buffers
                    .occupied_group_indices
                    .windows(2)
                    .all(|pair| pair[0] < pair[1])
                && buffers
                    .workspace
                    .matches_dimensions(belt_count, group_count, target_slot_count)
        });
        #[cfg(test)]
        let runtime_workspace_reused = reusable.is_some();
        let (active_groups, workspace) = reusable
            .map(|mut buffers| {
                // A pool may have been returned by a divergent disposable
                // clone. Clear exactly the resident snapshot's proven true
                // bits before finish_activity seeds this borrower's immutable
                // activity set; no factory-wide fill is needed on success.
                for &group_index in buffers.occupied_group_indices.iter() {
                    buffers.active_groups[expand_compact_index(group_index)] = false;
                }
                (buffers.active_groups, buffers.workspace)
            })
            .unwrap_or_else(|| {
                (
                    vec![false; group_count],
                    BeltWorkspace::new(belt_count, group_count, target_slot_count),
                )
            });
        Self {
            reusable_pool: None,
            source: None,
            progress: BeltPagedColumn::default(),
            total_transferred: BeltPagedColumn::default(),
            congestion: BeltPagedColumn::default(),
            last_flow: BeltPagedColumn::default(),
            total_dirty: BeltPagedColumn::with_len_default(belt_count),
            touched_routes: TouchedRoutes::default(),
            belt_capacity: prepared_routes.total_capacity,
            active_groups,
            // A carried snapshot repopulates only its sorted O(active) rows.
            // Reserving every topology group here recreated a factory-sized
            // allocation on every otherwise sparse revision.
            active_group_indices: Vec::new(),
            active_queue_enabled: false,
            diagnostics: BeltSchedulerDiagnostics {
                route_count: prepared_routes.routes.len(),
                group_count: prepared_routes.groups.len(),
                #[cfg(test)]
                runtime_workspace_reused,
                #[cfg(test)]
                runtime_workspace_initialized_route_rows: if runtime_workspace_reused {
                    0
                } else {
                    belt_count
                },
                #[cfg(test)]
                runtime_workspace_initialized_group_rows: if runtime_workspace_reused {
                    0
                } else {
                    group_count
                },
                #[cfg(test)]
                runtime_workspace_initialized_target_rows: if runtime_workspace_reused {
                    0
                } else {
                    target_slot_count
                },
                ..BeltSchedulerDiagnostics::default()
            },
            workspace,
        }
    }

    fn finish_activity(
        mut self,
        state: &CoreState,
        entities: &[Value],
        prepared_routes: &Arc<PreparedRoutes>,
        carried: Option<Arc<BeltActivitySnapshot>>,
    ) -> anyhow::Result<Self> {
        if self.progress.len() != prepared_routes.routes.len() {
            bail!("native belt runtime topology changed");
        }
        if let Some(carried) = carried.filter(|snapshot| snapshot.matches_topology(prepared_routes))
        {
            for &group_index in carried.active_group_indices.iter() {
                self.active_groups[expand_compact_index(group_index)] = true;
            }
            self.active_group_indices
                .extend_from_slice(&carried.active_group_indices);
            self.active_queue_enabled = carried.active_queue_enabled;
            self.diagnostics.active_queue_enabled = carried.active_queue_enabled;
            self.diagnostics.carried_active_groups = self.active_group_indices.len();
            return Ok(self);
        }
        let mut initially_dormant_routes = 0_usize;
        for (group_index, group) in prepared_routes.groups.iter().enumerate() {
            self.diagnostics.initialization_group_checks = self
                .diagnostics
                .initialization_group_checks
                .saturating_add(1);
            let item_id = state
                .symbols
                .resolve(group.item_symbol)
                .ok_or_else(|| anyhow!("native prepared belt item is missing"))?;
            let source = entities[expand_compact_index(group.source_index)]
                .as_object()
                .ok_or_else(|| anyhow!("native belt source is not an object"))?;
            let has_source_output = output_amount(source, item_id) > EPSILON;
            let has_source_input = input_amount(source, item_id) > EPSILON;
            let has_runtime_signal = group.route_indices.iter().copied().any(|route_index| {
                let belt_index = expand_compact_index(route_index);
                self.progress[belt_index].abs() > EPSILON
                    || self.last_flow[belt_index].abs() > EPSILON
                    || self.congestion[belt_index].abs() > EPSILON
            });
            let has_complete_ordinary_input =
                ordinary_machine_has_complete_input_cycle(state, source, item_id);
            self.active_groups[group_index] = has_source_output
                || has_source_input
                || has_runtime_signal
                || has_complete_ordinary_input
                || group.always_awake;
            if self.active_groups[group_index] {
                self.active_group_indices
                    .push(compact_index(group_index, "active group index")?);
            }
            if !self.active_groups[group_index] {
                initially_dormant_routes += group.route_indices.len();
            }
        }
        let dormant_threshold = if prepared_routes.routes.len() >= 50_000 {
            256.max(prepared_routes.routes.len().div_ceil(50))
        } else {
            64.max(prepared_routes.routes.len().div_ceil(10))
        };
        self.active_queue_enabled = initially_dormant_routes >= dormant_threshold;
        self.diagnostics.active_queue_enabled = self.active_queue_enabled;
        Ok(self)
    }

    pub(crate) fn from_state(
        state: &CoreState,
        entities: &[Value],
        prepared_routes: &Arc<PreparedRoutes>,
        carried: Option<Arc<BeltActivitySnapshot>>,
    ) -> anyhow::Result<Self> {
        let belt_count = state.validate_belt_runtime_topology()?;
        let reusable_pool = carried
            .as_ref()
            .filter(|snapshot| snapshot.matches_topology(prepared_routes))
            .map(|snapshot| Arc::clone(&snapshot.reusable_pool));
        let reusable = reusable_pool.as_ref().and_then(|pool| pool.take());
        let mut runtime = Self::empty_with_reusable(belt_count, prepared_routes, reusable);
        runtime.reusable_pool = reusable_pool;
        runtime.source = Some(state.belt_commit_source());
        // Each clone copies only the fixed 64-entry top directory. Pages stay
        // shared with the source revision until an active route writes them.
        runtime.progress = state.belt_dynamics.progress.clone();
        runtime.total_transferred = state.belt_dynamics.total_transferred.clone();
        runtime.congestion = state.belt_dynamics.congestion.clone();
        runtime.last_flow = state.belt_dynamics.last_flow.clone();
        runtime.progress.clear_dirty();
        runtime.total_transferred.clear_dirty();
        runtime.congestion.clear_dirty();
        runtime.last_flow.clear_dirty();
        // The historical write-back canonicalizes absent/non-numeric
        // progress, lastFlow and congestion fields even if no transfer occurs.
        // Seed those rows into the same complete mutation evidence so sparse
        // write-back preserves byte/value semantics without rediscovering
        // them in a second full scan at commit time. totalTransferred remains
        // absent until an actual transfer marks it dirty.
        for &index in state.belt_dynamics.missing_required_rows() {
            runtime
                .touched_routes
                .record_index(expand_compact_index(index))?;
        }
        runtime.finish_activity(state, entities, prepared_routes, carried)
    }

    fn set_group_active(&mut self, group_index: usize, active: bool) -> anyhow::Result<()> {
        let previous = *self
            .active_groups
            .get(group_index)
            .ok_or_else(|| anyhow!("native belt activity group is outside the topology"))?;
        if previous == active {
            return Ok(());
        }
        let compact = compact_index(group_index, "active group index")?;
        match self.active_group_indices.binary_search(&compact) {
            Ok(position) if !active => {
                self.active_group_indices.remove(position);
                self.active_groups[group_index] = false;
                self.diagnostics.sleep_count = self.diagnostics.sleep_count.saturating_add(1);
            }
            Err(position) if active => {
                self.active_group_indices.insert(position, compact);
                self.active_groups[group_index] = true;
                self.diagnostics.wake_count = self.diagnostics.wake_count.saturating_add(1);
            }
            Ok(_) => self.active_groups[group_index] = true,
            Err(_) => self.active_groups[group_index] = false,
        }
        Ok(())
    }

    fn wake_group(&mut self, group_index: u32) -> anyhow::Result<()> {
        self.set_group_active(expand_compact_index(group_index), true)
    }

    pub(crate) fn activity_snapshot(
        &mut self,
        routes: &Arc<PreparedRoutes>,
    ) -> Arc<BeltActivitySnapshot> {
        let active_group_indices: Arc<[u32]> =
            std::mem::take(&mut self.active_group_indices).into();
        let reusable_runtime = BeltReusableRuntime {
            active_groups: std::mem::take(&mut self.active_groups),
            occupied_group_indices: Arc::clone(&active_group_indices),
            workspace: std::mem::take(&mut self.workspace),
        };
        let reusable_pool = self
            .reusable_pool
            .take()
            .unwrap_or_else(|| Arc::new(BeltReusablePool::default()));
        reusable_pool.put_if_empty(reusable_runtime);
        Arc::new(BeltActivitySnapshot {
            routes: Arc::clone(routes),
            active_group_indices,
            active_queue_enabled: self.active_queue_enabled,
            reusable_pool,
        })
    }

    #[cfg(test)]
    pub(crate) fn from_dynamics_for_test(
        state: &CoreState,
        dynamics: BeltDynamicColumns,
    ) -> anyhow::Result<Self> {
        let belt_count = state.validate_belt_runtime_topology()?;
        dynamics.validate(belt_count)?;
        let mut total_dirty = BeltPagedColumn::with_len_default(belt_count);
        for (index, (next, previous)) in dynamics
            .total_transferred
            .iter()
            .zip(&state.belt_dynamics.total_transferred)
            .enumerate()
        {
            if next.to_bits() != previous.to_bits() {
                total_dirty[index] = true;
            }
        }
        let mut runtime = Self {
            reusable_pool: None,
            source: Some(state.belt_commit_source()),
            progress: dynamics.progress,
            total_transferred: dynamics.total_transferred,
            congestion: dynamics.congestion,
            last_flow: dynamics.last_flow,
            total_dirty,
            touched_routes: TouchedRoutes::default(),
            belt_capacity: 0.0,
            active_groups: Vec::new(),
            active_group_indices: Vec::new(),
            active_queue_enabled: false,
            diagnostics: BeltSchedulerDiagnostics::default(),
            workspace: BeltWorkspace::new(belt_count, 0, 0),
        };
        for index in 0..belt_count {
            if runtime.record_needs_write(&state.belt_dynamics, index) {
                runtime.touched_routes.record_index(index)?;
            }
        }
        Ok(runtime)
    }

    #[cfg(test)]
    pub(crate) fn clear_total_dirty_for_test(&mut self, index: usize) {
        self.total_dirty[index] = false;
    }

    #[cfg(test)]
    pub(crate) fn record_touched_for_test(&mut self, index: usize) -> anyhow::Result<()> {
        self.touched_routes.record_index(index)
    }

    #[cfg(test)]
    pub(crate) fn truncate_column_for_test(&mut self, column: &str) {
        match column {
            "progress" => {
                self.progress.pop();
            }
            "totalTransferred" => {
                self.total_transferred.pop();
            }
            "congestion" => {
                self.congestion.pop();
            }
            "lastFlow" => {
                self.last_flow.pop();
            }
            "totalDirty" => {
                self.total_dirty.pop();
            }
            _ => unreachable!("bounded test-only belt runtime column"),
        }
    }

    fn record_selection(
        &mut self,
        prepared_routes: &PreparedRoutes,
        selection: &ActiveSelection,
        reservation: bool,
    ) {
        let selected_routes = selection.selected_routes(prepared_routes.routes.len());
        let skipped = (prepared_routes.routes.len() as u64).saturating_sub(selected_routes);
        if reservation {
            self.diagnostics.reservation_passes =
                self.diagnostics.reservation_passes.saturating_add(1);
            self.diagnostics.reservation_route_checks = self
                .diagnostics
                .reservation_route_checks
                .saturating_add(selected_routes);
        } else {
            self.diagnostics.transfer_passes = self.diagnostics.transfer_passes.saturating_add(1);
            self.diagnostics.transfer_route_checks = self
                .diagnostics
                .transfer_route_checks
                .saturating_add(selected_routes);
        }
        if selection.is_full_scan() {
            self.diagnostics.full_scan_passes = self.diagnostics.full_scan_passes.saturating_add(1);
        }
        self.diagnostics.stable_routes_skipped = self
            .diagnostics
            .stable_routes_skipped
            .saturating_add(skipped);
    }

    #[inline]
    fn record_needs_write(&self, persisted: &BeltDynamicColumns, index: usize) -> bool {
        !persisted.persisted_number_matches(
            index,
            BeltDynamicColumns::PROGRESS,
            self.progress[index],
        ) || !persisted.persisted_number_matches(
            index,
            BeltDynamicColumns::LAST_FLOW,
            self.last_flow[index],
        ) || !persisted.persisted_number_matches(
            index,
            BeltDynamicColumns::CONGESTION,
            self.congestion[index],
        ) || self.total_dirty[index]
            && !persisted.persisted_number_matches(
                index,
                BeltDynamicColumns::TOTAL_TRANSFERRED,
                self.total_transferred[index],
            )
    }

    fn raw_patch_for_index(&self, state: &CoreState, index: usize) -> anyhow::Result<BeltRawPatch> {
        let changed = self.record_needs_write(&state.belt_dynamics, index);
        let dynamic_patch = if changed {
            BeltDynamicRawPatch {
                progress: Some(self.progress[index]),
                total_transferred: self.total_dirty[index].then_some(self.total_transferred[index]),
                congestion: Some(self.congestion[index]),
                last_flow: Some(self.last_flow[index]),
            }
        } else {
            BeltDynamicRawPatch::default()
        };
        rewrite_belt_raw_patch(index, state.belt_raw_record(index), dynamic_patch)
    }

    pub(crate) fn into_patches(
        self,
        state: &CoreState,
        flow_requirement: BeltFlowRequirement,
    ) -> anyhow::Result<(BeltCommitBatch, PreparedBeltFlow, BeltSchedulerDiagnostics)> {
        self.into_patches_with_runtime(state, flow_requirement, deterministic_runtime())
    }

    fn into_patches_with_runtime(
        mut self,
        state: &CoreState,
        flow_requirement: BeltFlowRequirement,
        runtime: &DeterministicRuntime,
    ) -> anyhow::Result<(BeltCommitBatch, PreparedBeltFlow, BeltSchedulerDiagnostics)> {
        let belt_count = state.validate_belt_runtime_topology()?;
        if self
            .source
            .as_ref()
            .is_none_or(|source| !source.matches(state))
        {
            bail!("native belt runtime source changed before commit sealing");
        }
        if self.progress.len() != belt_count
            || self.total_transferred.len() != belt_count
            || self.congestion.len() != belt_count
            || self.last_flow.len() != belt_count
            || self.total_dirty.len() != belt_count
        {
            bail!("native belt runtime topology changed");
        }
        let touched = std::mem::take(&mut self.touched_routes)
            .seal(belt_count)?
            .unseal()?;

        // Production history consumes this aggregate only on its 10-second
        // diagnostics refresh boundary. Never replace the historical fold
        // with an incrementally maintained float: original row order is part
        // of JavaScript bitwise compatibility whenever the value is observed.
        let prepared_flow = match flow_requirement {
            BeltFlowRequirement::NotRequired => PreparedBeltFlow::NotRequired,
            BeltFlowRequirement::ExactOriginalOrder => {
                let mut flow = 0.0;
                for last_flow in &self.last_flow {
                    flow += last_flow.max(0.0);
                }
                self.diagnostics.write_back_flow_checks = belt_count;
                PreparedBeltFlow::Exact(BeltFlowAggregate {
                    capacity: self.belt_capacity,
                    flow,
                })
            }
        };

        let mut changed_count = 0_usize;
        let mut number_mask = state.belt_dynamics.number_mask.clone();
        number_mask.clear_dirty();
        let mut sparse_patches = None;
        let mut all_changed_indices = None;
        match touched {
            TouchedRouteEvidence::Sparse(indices) => {
                self.diagnostics.write_back_evidence_checks = indices.len();
                let mut patches = Vec::with_capacity(indices.len());
                for compact in indices.iter().copied() {
                    let index = expand_compact_index(compact);
                    if !self.total_dirty[index]
                        && self.total_transferred[index].to_bits()
                            != state.belt_dynamics.total_transferred[index].to_bits()
                    {
                        bail!("native belt transfer total changed without a dirty marker");
                    }
                    let changed = self.record_needs_write(&state.belt_dynamics, index);
                    changed_count += usize::from(changed);
                    if !changed {
                        continue;
                    }
                    number_mask[index] |= (1 << BeltDynamicColumns::PROGRESS)
                        | (1 << BeltDynamicColumns::LAST_FLOW)
                        | (1 << BeltDynamicColumns::CONGESTION);
                    if self.total_dirty[index] {
                        number_mask[index] |= 1 << BeltDynamicColumns::TOTAL_TRANSFERRED;
                    }
                    // Sparse evidence validates the dirty-total invariant and
                    // materializes this exact row in the same ordered pass.
                    patches.push(self.raw_patch_for_index(state, index)?);
                }
                sparse_patches = Some(patches);
            }
            TouchedRouteEvidence::All => {
                self.diagnostics.write_back_evidence_checks = belt_count;
                let mut changed_indices = Vec::new();
                for index in 0..belt_count {
                    if !self.total_dirty[index]
                        && self.total_transferred[index].to_bits()
                            != state.belt_dynamics.total_transferred[index].to_bits()
                    {
                        bail!("native belt transfer total changed without a dirty marker");
                    }
                    let changed = self.record_needs_write(&state.belt_dynamics, index);
                    changed_count += usize::from(changed);
                    if !changed {
                        continue;
                    }
                    number_mask[index] |= (1 << BeltDynamicColumns::PROGRESS)
                        | (1 << BeltDynamicColumns::LAST_FLOW)
                        | (1 << BeltDynamicColumns::CONGESTION);
                    if self.total_dirty[index] {
                        number_mask[index] |= 1 << BeltDynamicColumns::TOTAL_TRANSFERRED;
                    }
                    changed_indices.push(compact_index(index, "changed belt index")?);
                }
                all_changed_indices = Some(changed_indices);
            }
        }
        // Preserve the historical dense threshold: a dense write-back
        // canonicalizes every row just as the former full Value encode did,
        // while sparse write-back retains untouched raw Arcs. Unlike the old
        // commit path, the resulting batch is already identity/dynamics
        // validated and needs no projection decode or unchanged-row rescan.
        let plan = belt_writeback_plan(runtime, belt_count, changed_count);
        let patches = if plan.dense {
            // The ordered range collector writes directly into the final
            // patch vector. On a malformed row, its bounded error slot waits
            // for all work and returns the lowest belt index; placeholder Arc
            // clones are dropped with the vector and never enter the seal.
            runtime.indexed_try_map_range(
                0..belt_count,
                |index| self.raw_patch_for_index(state, index),
                |index| BeltRawPatch {
                    index,
                    raw: state.belt_raw_record(index).clone(),
                },
            )?
        } else {
            if let Some(patches) = sparse_patches {
                debug_assert_eq!(patches.len(), plan.patch_count);
                patches
            } else {
                let changed_indices = all_changed_indices
                    .ok_or_else(|| anyhow!("native belt write-back evidence is missing"))?;
                let mut patches = Vec::with_capacity(plan.patch_count);
                for compact in changed_indices {
                    patches.push(self.raw_patch_for_index(state, expand_compact_index(compact))?);
                }
                patches
            }
        };
        if !self.belt_capacity.is_finite()
            || matches!(prepared_flow, PreparedBeltFlow::Exact(aggregate) if !aggregate.flow.is_finite())
        {
            bail!("native belt aggregate is non-finite");
        }
        self.diagnostics.changed_belt_records = changed_count;
        self.diagnostics.write_back_patch_records = patches.len();
        self.diagnostics.write_back_workers = plan.worker_count;
        if std::env::var_os("DSP_NATIVE_CORE_PROFILE").is_some() {
            eprintln!(
                "DSP_NATIVE_CORE_PROFILE\tstate-belt-runtime-write-back-records\t{belt_count}"
            );
            eprintln!(
                "DSP_NATIVE_CORE_PROFILE\tstate-belt-runtime-write-back-changed\t{changed_count}"
            );
            eprintln!(
                "DSP_NATIVE_CORE_PROFILE\tstate-belt-runtime-write-back-patches\t{}",
                patches.len()
            );
            eprintln!(
                "DSP_NATIVE_CORE_PROFILE\tstate-belt-runtime-write-back-workers\t{}",
                plan.worker_count
            );
        }
        let mut dynamics = BeltDynamicColumns::from_runtime_columns(
            std::mem::take(&mut self.progress),
            std::mem::take(&mut self.total_transferred),
            std::mem::take(&mut self.congestion),
            std::mem::take(&mut self.last_flow),
            number_mask,
        );
        self.diagnostics.dynamic_cow_pages = dynamics.dynamic_dirty_page_count();
        self.diagnostics.mask_cow_pages = dynamics.number_mask.dirty_page_count();
        self.diagnostics.dirty_validation_rows = dynamics.validate_dirty(belt_count)?;
        dynamics.clear_dirty();
        let dynamics = (changed_count != 0).then_some(dynamics);
        let source = self
            .source
            .take()
            .ok_or_else(|| anyhow!("native belt runtime source proof is missing"))?;
        let batch = BeltCommitBatch::seal(source, patches, dynamics);
        Ok((batch, prepared_flow, std::mem::take(&mut self.diagnostics)))
    }

    #[cfg(test)]
    pub(crate) fn into_patches_with_worker_count_for_test(
        self,
        state: &CoreState,
        workers: usize,
        flow_requirement: BeltFlowRequirement,
    ) -> anyhow::Result<(BeltCommitBatch, PreparedBeltFlow, BeltSchedulerDiagnostics)> {
        self.into_patches_with_runtime(
            state,
            flow_requirement,
            &DeterministicRuntime::for_test(workers),
        )
    }
}

impl Drop for BeltRuntime {
    fn drop(&mut self) {
        let Some(pool) = self.reusable_pool.take() else {
            return;
        };
        // Drop means the candidate never published an activity snapshot.
        // Restore a topology-sized but logically empty scratch lease to the
        // shared committed pool. The immutable source snapshot will seed its
        // own active indices on the next retry, so a failed or discarded clone
        // cannot leak candidate activity into another revision.
        self.active_groups.fill(false);
        self.active_group_indices.clear();
        self.workspace.reset_after_failed_candidate();
        pool.put_if_empty(BeltReusableRuntime {
            active_groups: std::mem::take(&mut self.active_groups),
            occupied_group_indices: Arc::from([]),
            workspace: std::mem::take(&mut self.workspace),
        });
    }
}

#[repr(C)]
#[derive(Debug, Clone)]
struct Route {
    capacity: f64,
    source_index: u32,
    target_index: u32,
    source_group: u32,
    target_slot: u32,
    belt_sort_rank: u32,
    target_port_index: Option<u8>,
    priority: u8,
}

#[derive(Debug, Clone)]
pub(crate) struct PreparedRoutes {
    routes: Vec<Route>,
    groups: Vec<PreparedGroup>,
    target_slot_count: u32,
    total_capacity: f64,
    group_by_key: Arc<HashMap<(u32, u32), u32>>,
}

#[repr(C)]
#[derive(Debug, Clone)]
struct PreparedGroup {
    source_index: u32,
    item_symbol: u32,
    balanced_splitter: bool,
    /// This source can create or receive output through a non-belt domain
    /// during an exact step. Keeping it awake closes those reverse
    /// dependencies without rescanning every group at every selection.
    always_awake: bool,
    route_indices: Box<[u32]>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum TargetSlotKey {
    Entity {
        target_index: u32,
        item: u32,
    },
    BlackHole {
        target_index: u32,
        port: i16,
    },
    OrbitalCargo {
        target_index: u32,
        item: u32,
        port: i16,
    },
    Tray {
        planet: u32,
        item: u32,
    },
}

#[inline]
fn compact_index(value: usize, label: &'static str) -> anyhow::Result<u32> {
    u32::try_from(value)
        .with_context(|| format!("native belt {label} exceeds the compact topology limit"))
}

#[inline]
fn expand_compact_index(value: u32) -> usize {
    usize::try_from(value).expect("validated compact belt index must fit usize")
}

impl Route {
    #[inline]
    fn source_index(&self) -> usize {
        expand_compact_index(self.source_index)
    }

    #[inline]
    fn target_index(&self) -> usize {
        expand_compact_index(self.target_index)
    }

    #[inline]
    fn source_group(&self) -> usize {
        expand_compact_index(self.source_group)
    }

    #[inline]
    fn target_slot(&self) -> usize {
        expand_compact_index(self.target_slot)
    }

    #[inline]
    fn belt_sort_rank(&self) -> usize {
        expand_compact_index(self.belt_sort_rank)
    }
}

trait BeltIdLookup {
    fn len(&self) -> usize;
    fn id(&self, index: usize) -> &str;
}

impl BeltIdLookup for ExactRowIds {
    fn len(&self) -> usize {
        self.len()
    }

    fn id(&self, index: usize) -> &str {
        &self[index]
    }
}

#[cfg(test)]
impl BeltIdLookup for Vec<Box<str>> {
    fn len(&self) -> usize {
        self.len()
    }

    fn id(&self, index: usize) -> &str {
        &self[index]
    }
}

fn sort_prepared_group_routes<T: BeltIdLookup + ?Sized>(
    routes: &mut [Route],
    groups: &mut [PreparedGroup],
    belt_ids: &T,
) -> anyhow::Result<()> {
    if routes.len() != belt_ids.len() {
        bail!("native belt sort topology changed");
    }
    for group in groups {
        group.route_indices.sort_by(|left, right| {
            belt_ids
                .id(expand_compact_index(*left))
                .cmp(belt_ids.id(expand_compact_index(*right)))
        });
        for (rank, route_index) in group.route_indices.iter().copied().enumerate() {
            routes[expand_compact_index(route_index)].belt_sort_rank =
                compact_index(rank, "belt sort rank")?;
        }
    }
    Ok(())
}

impl PreparedRoutes {
    pub(crate) fn estimated_bytes(&self) -> u64 {
        (self.routes.capacity() * size_of::<Route>()
            + self.groups.capacity() * size_of::<PreparedGroup>()
            + self
                .groups
                .iter()
                .map(|group| group.route_indices.len() * size_of::<u32>())
                .sum::<usize>()
            + self.group_by_key.capacity() * size_of::<((u32, u32), u32)>()) as u64
    }
}

#[derive(Debug)]
struct Candidate {
    route_index: usize,
    allowance: f64,
    moved: f64,
}

#[derive(Debug, Default)]
struct Group {
    available: f64,
    source_had_output: bool,
    first_candidate: Option<Candidate>,
    candidates: Vec<Candidate>,
    first_inactive_route: Option<usize>,
    inactive_routes: Vec<usize>,
}

#[derive(Debug, Clone, Copy)]
struct BeltSourceSnapshot {
    group_index: usize,
    available: f64,
    source_had_output: bool,
}

/// One target-capacity query in persisted first-use order. Routes that feed
/// the same target slot intentionally share one query: that slot is the
/// smallest conflict component whose free capacity is consumed serially by
/// the legacy route order. Non-quantum components are immutable probes and
/// may run in private worker plans; quantum supply remains in the stable
/// serial stream because it shares one network deposit session.
#[derive(Debug, Clone, Copy)]
struct TargetCapacityPlanEntry {
    route_index: u32,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct TargetCapacityPlanDiagnostics {
    component_count: usize,
    parallel_component_count: usize,
    serial_component_count: usize,
    worker_count: usize,
}

#[derive(Debug)]
struct BeltTransferProfiler {
    enabled: bool,
    checkpoint: std::time::Instant,
}

impl BeltTransferProfiler {
    fn new() -> Self {
        Self {
            enabled: std::env::var_os("DSP_NATIVE_CORE_PROFILE").is_some(),
            checkpoint: std::time::Instant::now(),
        }
    }

    fn mark(&mut self, label: &'static str) {
        if self.enabled {
            eprintln!(
                "DSP_NATIVE_CORE_PROFILE\t{label}\t{:.3}",
                self.checkpoint.elapsed().as_secs_f64() * 1_000.0
            );
            self.checkpoint = std::time::Instant::now();
        }
    }

    fn target_capacity_plan(&self, diagnostics: TargetCapacityPlanDiagnostics) {
        if self.enabled {
            eprintln!(
                "DSP_NATIVE_CORE_PROFILE\tbelt-transfer-target-capacity-plan-workers\tworkers={}\tcomponents={}\tparallel={}\tserial={}",
                diagnostics.worker_count,
                diagnostics.component_count,
                diagnostics.parallel_component_count,
                diagnostics.serial_component_count,
            );
        }
    }

    fn reservation_target_capacity_plan(&self, diagnostics: TargetCapacityPlanDiagnostics) {
        if self.enabled {
            eprintln!(
                "DSP_NATIVE_CORE_PROFILE\tbelt-reservation-target-capacity-plan-workers\tworkers={}\tcomponents={}\tparallel={}\tserial={}",
                diagnostics.worker_count,
                diagnostics.component_count,
                diagnostics.parallel_component_count,
                diagnostics.serial_component_count,
            );
        }
    }
}

#[derive(Debug, Clone, Copy, Default)]
enum BeltPostAction {
    #[default]
    None,
    ResetProgress,
    Flow {
        available: f64,
        free: f64,
        moved: f64,
    },
}

impl Group {
    fn reset(&mut self, available: f64, source_had_output: bool) {
        self.available = available;
        self.source_had_output = source_had_output;
        self.first_candidate = None;
        self.candidates.clear();
        self.first_inactive_route = None;
        self.inactive_routes.clear();
    }
}

#[derive(Debug, Default)]
struct BeltWorkspace {
    post_actions: Vec<BeltPostAction>,
    target_free: Vec<f64>,
    touched_target_slots: Vec<u32>,
    groups: Vec<Group>,
    usable_candidate_indices: Vec<usize>,
    active_candidate_indices: Vec<usize>,
    selected_group_indices: Vec<u32>,
    selected_route_indices: Vec<u32>,
    /// Passive storage/splitter sources are woken by cargo arriving on an
    /// incoming route. The events are applied after the transfer borrow ends
    /// so the active set stays sorted and deterministic.
    pending_wake_group_indices: Vec<u32>,
}

impl BeltWorkspace {
    fn new(belt_count: usize, group_count: usize, target_slot_count: usize) -> Self {
        let mut groups = Vec::with_capacity(group_count);
        groups.resize_with(group_count, Group::default);
        Self {
            post_actions: vec![BeltPostAction::None; belt_count],
            target_free: vec![f64::NAN; target_slot_count],
            touched_target_slots: Vec::with_capacity(target_slot_count.min(1_024)),
            groups,
            usable_candidate_indices: Vec::new(),
            active_candidate_indices: Vec::new(),
            selected_group_indices: Vec::with_capacity(group_count),
            selected_route_indices: Vec::with_capacity(belt_count),
            pending_wake_group_indices: Vec::with_capacity(group_count.min(1_024)),
        }
    }

    fn matches_dimensions(
        &self,
        belt_count: usize,
        group_count: usize,
        target_slot_count: usize,
    ) -> bool {
        self.post_actions.len() == belt_count
            && self.groups.len() == group_count
            && self.target_free.len() == target_slot_count
    }

    fn estimated_bytes(&self) -> u64 {
        let group_nested_bytes = self
            .groups
            .iter()
            .map(|group| {
                group.candidates.capacity() * size_of::<Candidate>()
                    + group.inactive_routes.capacity() * size_of::<usize>()
            })
            .sum::<usize>();
        (self.post_actions.capacity() * size_of::<BeltPostAction>()
            + self.target_free.capacity() * size_of::<f64>()
            + self.touched_target_slots.capacity() * size_of::<u32>()
            + self.groups.capacity() * size_of::<Group>()
            + group_nested_bytes
            + self.usable_candidate_indices.capacity() * size_of::<usize>()
            + self.active_candidate_indices.capacity() * size_of::<usize>()
            + self.selected_group_indices.capacity() * size_of::<u32>()
            + self.selected_route_indices.capacity() * size_of::<u32>()
            + self.pending_wake_group_indices.capacity() * size_of::<u32>()) as u64
    }

    fn reset_target_free(&mut self) {
        for target_slot in self.touched_target_slots.drain(..) {
            self.target_free[expand_compact_index(target_slot)] = f64::NAN;
        }
    }

    fn reset_transfer_buffers(
        &mut self,
        prepared_routes: &PreparedRoutes,
        selection: &ActiveSelection,
    ) {
        match selection {
            ActiveSelection::All | ActiveSelection::Dense { .. } => {
                self.post_actions.fill(BeltPostAction::None)
            }
            ActiveSelection::Mask {
                selected_group_indices,
                ..
            } => {
                for group_index in selected_group_indices.iter().copied() {
                    for route_index in prepared_routes.groups[expand_compact_index(group_index)]
                        .route_indices
                        .iter()
                        .copied()
                    {
                        self.post_actions[expand_compact_index(route_index)] = BeltPostAction::None;
                    }
                }
            }
        }
        self.reset_target_free();
        self.usable_candidate_indices.clear();
        self.active_candidate_indices.clear();
        self.pending_wake_group_indices.clear();
    }

    /// A failed disposable candidate may stop at any `?` inside transfer or
    /// reservation, before the ordinary success path has recycled its sparse
    /// buffers. Failure is rare, so use a complete logical reset while
    /// retaining every factory-sized allocation for the committed snapshot's
    /// next retry.
    fn reset_after_failed_candidate(&mut self) {
        self.post_actions.fill(BeltPostAction::None);
        self.target_free.fill(f64::NAN);
        self.touched_target_slots.clear();
        for group in &mut self.groups {
            group.reset(0.0, false);
        }
        self.usable_candidate_indices.clear();
        self.active_candidate_indices.clear();
        self.selected_group_indices.clear();
        self.selected_route_indices.clear();
        self.pending_wake_group_indices.clear();
    }
}

#[inline]
#[allow(clippy::too_many_arguments)]
fn advance_belt_clock_row(
    route: &Route,
    progress: &mut f64,
    congestion: &mut f64,
    last_flow: &mut f64,
    seconds: f64,
    belt_limit: f64,
    flow_decay: f64,
    congestion_decay: f64,
) {
    *last_flow = rounded(*last_flow * flow_decay, 3);
    *congestion = rounded(*congestion * congestion_decay, 3);
    let current = (*progress).max(0.0);
    *progress = rounded(
        if current > belt_limit {
            current
        } else {
            (current + route.capacity * seconds).min(belt_limit)
        },
        4,
    );
}

fn advance_belt_clocks_with_runtime(
    runtime: &mut BeltRuntime,
    prepared_routes: &PreparedRoutes,
    selection: &ActiveSelection,
    seconds: f64,
    belt_limit: f64,
    executor: &DeterministicRuntime,
) -> anyhow::Result<()> {
    if seconds <= 0.0 || runtime.progress.is_empty() {
        return Ok(());
    }
    // Every mutable column borrow below is dominated by this evidence write.
    // The selection is an over-approximation by design: rows whose rounded
    // values remain bitwise equal are filtered exactly during write-back.
    runtime
        .touched_routes
        .record_selection(prepared_routes, selection);
    let flow_decay = 0.8_f64.powf(seconds);
    let congestion_decay = 0.85_f64.powf(seconds);
    match selection {
        ActiveSelection::All | ActiveSelection::Dense { .. } => {
            let mut progress_pages = runtime.progress.materialized_pages_mut();
            let mut congestion_pages = runtime.congestion.materialized_pages_mut();
            let mut last_flow_pages = runtime.last_flow.materialized_pages_mut();
            executor.indexed_for_each_mut3_pages(
                BELT_DYNAMIC_PAGE_ROWS,
                &mut progress_pages,
                &mut congestion_pages,
                &mut last_flow_pages,
                |belt_index, progress, congestion, last_flow| {
                    advance_belt_clock_row(
                        &prepared_routes.routes[belt_index],
                        progress,
                        congestion,
                        last_flow,
                        seconds,
                        belt_limit,
                        flow_decay,
                        congestion_decay,
                    );
                },
            )?;
        }
        ActiveSelection::Mask {
            selected_group_indices,
            ..
        } => {
            for group_index in selected_group_indices.iter().copied() {
                for route_index in prepared_routes.groups[expand_compact_index(group_index)]
                    .route_indices
                    .iter()
                    .copied()
                {
                    let belt_index = expand_compact_index(route_index);
                    advance_belt_clock_row(
                        &prepared_routes.routes[belt_index],
                        &mut runtime.progress[belt_index],
                        &mut runtime.congestion[belt_index],
                        &mut runtime.last_flow[belt_index],
                        seconds,
                        belt_limit,
                        flow_decay,
                        congestion_decay,
                    );
                }
            }
        }
    }
    Ok(())
}

fn advance_belt_clocks(
    runtime: &mut BeltRuntime,
    prepared_routes: &PreparedRoutes,
    selection: &ActiveSelection,
    seconds: f64,
    belt_limit: f64,
) -> anyhow::Result<()> {
    advance_belt_clocks_with_runtime(
        runtime,
        prepared_routes,
        selection,
        seconds,
        belt_limit,
        deterministic_runtime(),
    )
}

#[allow(clippy::too_many_arguments)]
fn catch_up_newly_woken_ordinary_producer_clocks(
    runtime: &mut BeltRuntime,
    state: &CoreState,
    entities: &[Value],
    prepared_routes: &PreparedRoutes,
    captured_selection: &ActiveSelection,
    pending_wakes: &[u32],
    seconds: f64,
    belt_limit: f64,
) -> anyhow::Result<()> {
    if seconds <= 0.0 || captured_selection.is_full_scan() || pending_wakes.is_empty() {
        return Ok(());
    }
    let mut missed_group_indices = Vec::new();
    for group_index in pending_wakes.iter().copied() {
        if captured_selection.contains_group(group_index) {
            continue;
        }
        let group = prepared_routes
            .groups
            .get(expand_compact_index(group_index))
            .ok_or_else(|| anyhow!("native pending belt wake is outside the topology"))?;
        let item_id = state
            .symbols
            .resolve(group.item_symbol)
            .ok_or_else(|| anyhow!("native prepared belt item is missing"))?;
        let source = entities[expand_compact_index(group.source_index)]
            .as_object()
            .ok_or_else(|| anyhow!("native belt source is not an object"))?;
        if ordinary_machine_produces(state, source, item_id) {
            missed_group_indices.push(group_index);
        }
    }
    if missed_group_indices.is_empty() {
        return Ok(());
    }
    debug_assert!(
        missed_group_indices
            .windows(2)
            .all(|pair| pair[0] < pair[1])
    );
    let catch_up_selection = ActiveSelection::Mask {
        selected_group_indices: missed_group_indices,
        selected_route_indices: Vec::new(),
    };
    advance_belt_clocks(
        runtime,
        prepared_routes,
        &catch_up_selection,
        seconds,
        belt_limit,
    )
}

#[allow(clippy::too_many_arguments)]
#[inline]
fn apply_belt_post_action_row(
    route: &Route,
    action: BeltPostAction,
    progress: &mut f64,
    total_transferred: &mut f64,
    congestion: &mut f64,
    last_flow: &mut f64,
    total_dirty: &mut bool,
    seconds: f64,
    defer_source_depletion_reset: bool,
    flow_window_seconds: f64,
) {
    match action {
        BeltPostAction::None => {}
        BeltPostAction::ResetProgress => *progress = 0.0,
        BeltPostAction::Flow {
            available,
            free,
            moved,
        } => {
            *progress = if !defer_source_depletion_reset && available <= 0.0 || free <= 0.0 {
                0.0
            } else {
                rounded((*progress - moved).max(0.0), 4)
            };
            if moved > 0.0 {
                if flow_window_seconds > 0.0 {
                    let prior = if seconds > 0.0 { 0.0 } else { *last_flow };
                    *last_flow =
                        rounded(route.capacity.min(prior + moved / flow_window_seconds), 3);
                }
                *total_transferred = (*total_transferred + moved).floor();
                *total_dirty = true;
            }
            let load = if route.capacity > EPSILON {
                *last_flow / route.capacity
            } else {
                0.0
            };
            *congestion = rounded(
                1.0_f64.min(load.max(if available > 0.0 && free <= 0.0 {
                    1.0
                } else {
                    0.0
                })),
                3,
            );
        }
    }
}

fn apply_belt_post_actions_with_runtime(
    runtime: &mut BeltRuntime,
    prepared_routes: &PreparedRoutes,
    selection: &ActiveSelection,
    seconds: f64,
    defer_source_depletion_reset: bool,
    flow_window_seconds: f64,
    executor: &DeterministicRuntime,
) -> anyhow::Result<()> {
    // Post actions can reset progress or advance totalTransferred even when a
    // zero-second boundary skips the clock phase, so they independently seal
    // the complete selected route set into the mutation evidence.
    runtime
        .touched_routes
        .record_selection(prepared_routes, selection);
    let BeltRuntime {
        progress,
        total_transferred,
        congestion,
        last_flow,
        total_dirty,
        workspace,
        ..
    } = runtime;
    let actions = &workspace.post_actions;
    match selection {
        ActiveSelection::All | ActiveSelection::Dense { .. } => {
            let mut progress_pages = progress.materialized_pages_mut();
            let mut total_transferred_pages = total_transferred.materialized_pages_mut();
            let mut congestion_pages = congestion.materialized_pages_mut();
            let mut last_flow_pages = last_flow.materialized_pages_mut();
            let mut total_dirty_pages = total_dirty.materialized_pages_mut();
            executor.indexed_for_each_mut5_pages(
                BELT_DYNAMIC_PAGE_ROWS,
                &mut progress_pages,
                &mut total_transferred_pages,
                &mut congestion_pages,
                &mut last_flow_pages,
                &mut total_dirty_pages,
                |belt_index, progress, total_transferred, congestion, last_flow, total_dirty| {
                    apply_belt_post_action_row(
                        &prepared_routes.routes[belt_index],
                        actions[belt_index],
                        progress,
                        total_transferred,
                        congestion,
                        last_flow,
                        total_dirty,
                        seconds,
                        defer_source_depletion_reset,
                        flow_window_seconds,
                    );
                },
            )?;
        }
        ActiveSelection::Mask {
            selected_group_indices,
            ..
        } => {
            for group_index in selected_group_indices.iter().copied() {
                for route_index in prepared_routes.groups[expand_compact_index(group_index)]
                    .route_indices
                    .iter()
                    .copied()
                {
                    let belt_index = expand_compact_index(route_index);
                    apply_belt_post_action_row(
                        &prepared_routes.routes[belt_index],
                        actions[belt_index],
                        &mut progress[belt_index],
                        &mut total_transferred[belt_index],
                        &mut congestion[belt_index],
                        &mut last_flow[belt_index],
                        &mut total_dirty[belt_index],
                        seconds,
                        defer_source_depletion_reset,
                        flow_window_seconds,
                    );
                }
            }
        }
    }
    Ok(())
}

fn apply_belt_post_actions(
    runtime: &mut BeltRuntime,
    prepared_routes: &PreparedRoutes,
    selection: &ActiveSelection,
    seconds: f64,
    defer_source_depletion_reset: bool,
    flow_window_seconds: f64,
) -> anyhow::Result<()> {
    apply_belt_post_actions_with_runtime(
        runtime,
        prepared_routes,
        selection,
        seconds,
        defer_source_depletion_reset,
        flow_window_seconds,
        deterministic_runtime(),
    )
}

fn select_active_groups(
    runtime: &mut BeltRuntime,
    prepared_routes: &PreparedRoutes,
    mut selected_group_indices: Vec<u32>,
    mut selected_route_indices: Vec<u32>,
) -> ActiveSelection {
    if !runtime.active_queue_enabled {
        return ActiveSelection::All;
    }
    selected_group_indices.clear();
    selected_route_indices.clear();
    let mut selected_routes = 0_u64;
    runtime.diagnostics.selection_group_checks = runtime
        .diagnostics
        .selection_group_checks
        .saturating_add(runtime.active_group_indices.len() as u64);
    selected_group_indices.extend_from_slice(&runtime.active_group_indices);
    for group_index in selected_group_indices.iter().copied() {
        let group = &prepared_routes.groups[expand_compact_index(group_index)];
        selected_routes += group.route_indices.len() as u64;
        selected_route_indices.extend_from_slice(&group.route_indices);
    }
    let route_count = prepared_routes.routes.len() as u64;
    if selected_routes.saturating_mul(4) >= route_count.saturating_mul(3) {
        // Once at least 75% of routes are awake, scanning a dense flat column
        // is cheaper than repeatedly chasing per-group slices. Keep both
        // scratch allocations attached to the selection so the next sparse
        // pass can reuse them without rebuilding a factory-sized mask.
        ActiveSelection::Dense {
            selected_group_indices,
            selected_route_indices,
        }
    } else {
        // Reservation capacity is shared by target slot and historically
        // consumed in persisted belt-row order. Group slices are sorted for
        // source fairness, not globally by row, so recover the old stable
        // order before the sparse reservation pass skips dormant routes.
        selected_route_indices.sort_unstable();
        ActiveSelection::Mask {
            selected_group_indices,
            selected_route_indices,
        }
    }
}

fn with_active_selection<T>(
    runtime: &mut BeltRuntime,
    prepared_routes: &PreparedRoutes,
    operation: impl FnOnce(&mut BeltRuntime, &ActiveSelection) -> anyhow::Result<T>,
) -> anyhow::Result<T> {
    let selected_group_index_scratch = if runtime.active_queue_enabled {
        std::mem::take(&mut runtime.workspace.selected_group_indices)
    } else {
        Vec::new()
    };
    let selected_route_index_scratch = if runtime.active_queue_enabled {
        std::mem::take(&mut runtime.workspace.selected_route_indices)
    } else {
        Vec::new()
    };
    let selection = select_active_groups(
        runtime,
        prepared_routes,
        selected_group_index_scratch,
        selected_route_index_scratch,
    );
    let result = operation(runtime, &selection);
    selection.recycle_into(
        &mut runtime.workspace.selected_group_indices,
        &mut runtime.workspace.selected_route_indices,
    );
    result
}

fn refresh_active_groups(
    runtime: &mut BeltRuntime,
    state: &CoreState,
    entities: &[Value],
    prepared_routes: &PreparedRoutes,
    selection: &ActiveSelection,
) -> anyhow::Result<()> {
    if !runtime.active_queue_enabled {
        return Ok(());
    }
    let mut updates = Vec::with_capacity(selection.selected_groups(prepared_routes.groups.len()));
    for group_index in selection.group_indices(prepared_routes.groups.len()) {
        let group = &prepared_routes.groups[group_index];
        let item_id = state
            .symbols
            .resolve(group.item_symbol)
            .ok_or_else(|| anyhow!("native prepared belt item is missing"))?;
        let source = entities[expand_compact_index(group.source_index)]
            .as_object()
            .ok_or_else(|| anyhow!("native belt source is not an object"))?;
        let next = group.always_awake
            || output_amount(source, item_id) > EPSILON
            || ordinary_machine_has_complete_input_cycle(state, source, item_id)
            // Storage/splitter inputs are promoted to outputs at the start of
            // the next exact step. Keep an incoming wake alive across the
            // intervening zero-second post-production transfer.
            || input_amount(source, item_id) > EPSILON
            || group.route_indices.iter().copied().any(|route_index| {
                let belt_index = expand_compact_index(route_index);
                runtime.progress[belt_index].abs() > EPSILON
                    || runtime.last_flow[belt_index].abs() > EPSILON
                    || runtime.congestion[belt_index].abs() > EPSILON
            });
        updates.push((group_index, next));
    }
    for (group_index, next) in updates {
        runtime.set_group_active(group_index, next)?;
    }
    Ok(())
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
    let value = Value::Number(
        Number::from_f64(value)
            .ok_or_else(|| anyhow!("native belt simulation produced a non-finite number"))?,
    );
    if let Some(target) = object.get_mut(key) {
        *target = value;
    } else {
        object.insert(key.to_owned(), value);
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, Default)]
struct BeltDynamicRawPatch {
    progress: Option<f64>,
    total_transferred: Option<f64>,
    congestion: Option<f64>,
    last_flow: Option<f64>,
}

impl BeltDynamicRawPatch {
    fn values(self) -> [Option<f64>; 4] {
        [
            self.progress,
            self.total_transferred,
            self.congestion,
            self.last_flow,
        ]
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BeltRawField {
    Id,
    Dynamic(usize),
    Other,
}

#[derive(Debug, Clone, Copy)]
struct BeltRawMember {
    leading_start: usize,
    value_start: usize,
    value_end: usize,
    trailing_end: usize,
    field: BeltRawField,
}

#[inline]
fn skip_json_whitespace(bytes: &[u8], mut cursor: usize) -> usize {
    while cursor < bytes.len() && matches!(bytes[cursor], b' ' | b'\t' | b'\r' | b'\n') {
        cursor += 1;
    }
    cursor
}

fn json_string_token_end(bytes: &[u8], start: usize) -> anyhow::Result<usize> {
    if bytes.get(start) != Some(&b'"') {
        bail!("native belt raw object key is not a string");
    }
    let mut cursor = start + 1;
    let mut escaped = false;
    while let Some(&byte) = bytes.get(cursor) {
        cursor += 1;
        if escaped {
            escaped = false;
        } else if byte == b'\\' {
            escaped = true;
        } else if byte == b'"' {
            return Ok(cursor);
        }
    }
    bail!("native belt raw object key is unterminated")
}

fn classify_belt_raw_key(raw_key: &str) -> anyhow::Result<BeltRawField> {
    let direct = match raw_key {
        "\"id\"" => Some(BeltRawField::Id),
        "\"progress\"" => Some(BeltRawField::Dynamic(BeltDynamicColumns::PROGRESS)),
        "\"totalTransferred\"" => {
            Some(BeltRawField::Dynamic(BeltDynamicColumns::TOTAL_TRANSFERRED))
        }
        "\"congestion\"" => Some(BeltRawField::Dynamic(BeltDynamicColumns::CONGESTION)),
        "\"lastFlow\"" => Some(BeltRawField::Dynamic(BeltDynamicColumns::LAST_FLOW)),
        _ => None,
    };
    if let Some(field) = direct {
        return Ok(field);
    }
    if !raw_key.as_bytes().contains(&b'\\') {
        return Ok(BeltRawField::Other);
    }
    let decoded: String = serde_json::from_str(raw_key).context("decode native belt raw key")?;
    Ok(match decoded.as_str() {
        "id" => BeltRawField::Id,
        "progress" => BeltRawField::Dynamic(BeltDynamicColumns::PROGRESS),
        "totalTransferred" => BeltRawField::Dynamic(BeltDynamicColumns::TOTAL_TRANSFERRED),
        "congestion" => BeltRawField::Dynamic(BeltDynamicColumns::CONGESTION),
        "lastFlow" => BeltRawField::Dynamic(BeltDynamicColumns::LAST_FLOW),
        _ => BeltRawField::Other,
    })
}

fn raw_json_value_end(raw: &str, start: usize) -> anyhow::Result<usize> {
    let mut stream = Deserializer::from_str(&raw[start..]).into_iter::<&RawValue>();
    let value = stream
        .next()
        .transpose()
        .context("decode native belt raw member")?;
    if value.is_none() {
        bail!("native belt raw member value is missing");
    }
    Ok(start + stream.byte_offset())
}

fn scan_belt_raw_object(raw: &str) -> anyhow::Result<(usize, usize, Vec<BeltRawMember>)> {
    // RawValue validates the complete JSON grammar without constructing the
    // nested Value/Map graph that dominates dense real-save write-back.
    let _: &RawValue = serde_json::from_str(raw).context("validate native belt raw record")?;
    let bytes = raw.as_bytes();
    let object_start = skip_json_whitespace(bytes, 0);
    if bytes.get(object_start) != Some(&b'{') {
        bail!("native belt raw record is not an object");
    }
    let body_start = object_start + 1;
    let mut leading_start = body_start;
    let mut cursor = skip_json_whitespace(bytes, body_start);
    let mut members = Vec::new();
    if bytes.get(cursor) == Some(&b'}') {
        return Ok((body_start, cursor, members));
    }
    loop {
        let key_start = cursor;
        let key_end = json_string_token_end(bytes, key_start)?;
        let field = classify_belt_raw_key(&raw[key_start..key_end])?;
        cursor = skip_json_whitespace(bytes, key_end);
        if bytes.get(cursor) != Some(&b':') {
            bail!("native belt raw object member is missing a colon");
        }
        cursor = skip_json_whitespace(bytes, cursor + 1);
        let value_start = cursor;
        let value_end = raw_json_value_end(raw, value_start)?;
        cursor = skip_json_whitespace(bytes, value_end);
        members.push(BeltRawMember {
            leading_start,
            value_start,
            value_end,
            trailing_end: cursor,
            field,
        });
        match bytes.get(cursor) {
            Some(b',') => {
                leading_start = cursor + 1;
                cursor = skip_json_whitespace(bytes, leading_start);
            }
            Some(b'}') => return Ok((body_start, cursor, members)),
            _ => bail!("native belt raw object member has an invalid delimiter"),
        }
    }
}

fn encoded_belt_number(value: f64) -> anyhow::Result<Number> {
    Number::from_f64(value)
        .ok_or_else(|| anyhow!("native belt simulation produced a non-finite number"))
}

/// Rewrites only the four mutable top-level belt numbers. Every unrelated
/// member is copied byte-for-byte, including nested mod payloads, original key
/// escapes and member order. Known duplicate keys retain their first insertion
/// position and their last value, matching JSON object last-value semantics,
/// and are emitted once so the lightweight commit projection remains valid.
/// `None` means the original Arc can be shared without any new allocation.
fn rewrite_belt_dynamic_raw(
    raw: &str,
    patch: BeltDynamicRawPatch,
) -> anyhow::Result<Option<String>> {
    let (body_start, object_end, members) = scan_belt_raw_object(raw)?;
    let patch_values = patch.values();
    let mut encoded = [None, None, None, None];
    for (slot, value) in patch_values.into_iter().enumerate() {
        if let Some(value) = value {
            encoded[slot] = Some(encoded_belt_number(value)?);
        }
    }

    // Slot zero tracks identity; the remaining slots track dynamic fields.
    let mut first = [usize::MAX; 5];
    let mut last = [usize::MAX; 5];
    let mut count = [0_usize; 5];
    for (index, member) in members.iter().enumerate() {
        let slot = match member.field {
            BeltRawField::Id => Some(0),
            BeltRawField::Dynamic(dynamic) => Some(dynamic + 1),
            BeltRawField::Other => None,
        };
        if let Some(slot) = slot {
            if first[slot] == usize::MAX {
                first[slot] = index;
            }
            last[slot] = index;
            count[slot] += 1;
        }
    }
    let needs_rewrite =
        encoded.iter().any(Option::is_some) || count.iter().any(|occurrences| *occurrences > 1);
    if !needs_rewrite {
        return Ok(None);
    }

    let mut output = String::with_capacity(raw.len().saturating_add(192));
    output.push_str(&raw[..body_start]);
    let mut wrote_member = false;
    for (index, member) in members.iter().enumerate() {
        let tracked_slot = match member.field {
            BeltRawField::Id => Some(0),
            BeltRawField::Dynamic(dynamic) => Some(dynamic + 1),
            BeltRawField::Other => None,
        };
        if tracked_slot.is_some_and(|slot| first[slot] != index) {
            continue;
        }
        if wrote_member {
            output.push(',');
        }
        output.push_str(&raw[member.leading_start..member.value_start]);
        match member.field {
            BeltRawField::Dynamic(slot) => {
                if let Some(value) = encoded[slot].as_ref() {
                    write!(&mut output, "{value}")
                        .map_err(|_| anyhow!("encode native belt dynamic number"))?;
                } else {
                    let source = &members[last[slot + 1]];
                    output.push_str(&raw[source.value_start..source.value_end]);
                }
            }
            BeltRawField::Id => {
                let source = &members[last[0]];
                output.push_str(&raw[source.value_start..source.value_end]);
            }
            BeltRawField::Other => {
                output.push_str(&raw[member.value_start..member.value_end]);
            }
        }
        output.push_str(&raw[member.value_end..member.trailing_end]);
        wrote_member = true;
    }

    // Match the existing write-back contract: progress, lastFlow and
    // congestion are always written for a dirty row; totalTransferred is
    // inserted only when the transfer counter itself became dirty.
    for slot in [
        BeltDynamicColumns::PROGRESS,
        BeltDynamicColumns::LAST_FLOW,
        BeltDynamicColumns::CONGESTION,
        BeltDynamicColumns::TOTAL_TRANSFERRED,
    ] {
        let Some(value) = encoded[slot].as_ref() else {
            continue;
        };
        if first[slot + 1] != usize::MAX {
            continue;
        }
        if wrote_member {
            output.push(',');
        }
        output.push('"');
        output.push_str(match slot {
            BeltDynamicColumns::PROGRESS => "progress",
            BeltDynamicColumns::TOTAL_TRANSFERRED => "totalTransferred",
            BeltDynamicColumns::CONGESTION => "congestion",
            BeltDynamicColumns::LAST_FLOW => "lastFlow",
            _ => unreachable!("bounded native belt dynamic slot"),
        });
        output.push_str("\":");
        write!(&mut output, "{value}").map_err(|_| anyhow!("encode native belt dynamic number"))?;
        wrote_member = true;
    }
    output.push_str(&raw[object_end..]);
    Ok(Some(output))
}

fn rewrite_belt_raw_patch(
    index: usize,
    previous: &RawRecord,
    patch: BeltDynamicRawPatch,
) -> anyhow::Result<BeltRawPatch> {
    let raw = rewrite_belt_dynamic_raw(previous, patch)
        .with_context(|| format!("rewrite native simulated belt row {index}"))?
        .map_or_else(|| previous.clone(), Arc::<str>::from);
    Ok(BeltRawPatch { index, raw })
}

fn normalized_buffer_limit(value: Option<&Value>) -> f64 {
    value
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

fn output_amount(entity: &Map<String, Value>, item_id: &str) -> f64 {
    entity
        .get("outputs")
        .and_then(Value::as_object)
        .and_then(|outputs| outputs.get(item_id))
        .map(|value| finite_number(Some(value)))
        .unwrap_or(0.0)
}

fn input_amount(entity: &Map<String, Value>, item_id: &str) -> f64 {
    entity
        .get("inputs")
        .and_then(Value::as_object)
        .and_then(|inputs| inputs.get(item_id))
        .map(|value| finite_number(Some(value)))
        .unwrap_or(0.0)
}

#[inline]
fn overwrite_or_insert_item_value(items: &mut Map<String, Value>, item_id: &str, value: Value) {
    if let Some(current) = items.get_mut(item_id) {
        *current = value;
    } else {
        items.insert(item_id.to_owned(), value);
    }
}

fn set_output(entity: &mut Map<String, Value>, item_id: &str, amount: f64) -> anyhow::Result<()> {
    let outputs = entity
        .get_mut("outputs")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native belt source outputs are missing"))?;
    let value = Number::from_f64(amount)
        .map(Value::Number)
        .ok_or_else(|| anyhow!("native belt output is non-finite"))?;
    overwrite_or_insert_item_value(outputs, item_id, value);
    Ok(())
}

fn add_input(entity: &mut Map<String, Value>, item_id: &str, amount: f64) -> anyhow::Result<()> {
    let inputs = entity
        .get_mut("inputs")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native belt target inputs are missing"))?;
    let current = inputs
        .get(item_id)
        .map(|value| finite_number(Some(value)))
        .unwrap_or(0.0);
    let value = Number::from_f64((current + amount).floor())
        .map(Value::Number)
        .ok_or_else(|| anyhow!("native belt input is non-finite"))?;
    overwrite_or_insert_item_value(inputs, item_id, value);
    Ok(())
}

fn black_hole_active(target: &Map<String, Value>) -> bool {
    string_at(target, "buildingId") == Some("micro_black_hole_connector")
        && target.get("blackHolePaused").and_then(Value::as_bool) == Some(false)
        && target
            .get("blackHoleActivationConfirmed")
            .and_then(Value::as_bool)
            == Some(true)
}

fn material_delivery_slot_accepts(
    target: &Map<String, Value>,
    item_id: &str,
    port_index: Option<u8>,
) -> bool {
    let Some(index) = port_index.filter(|index| *index <= 2).map(usize::from) else {
        return false;
    };
    if let Some(slots) = target.get("deliverySlots").and_then(Value::as_array) {
        let Some(slot) = slots.get(index).and_then(Value::as_object) else {
            return false;
        };
        if string_at(slot, "mode") == Some("disabled") {
            return false;
        }
        return string_at(slot, "itemId").is_none_or(|configured| configured == item_id);
    }
    target
        .get("deliveryItemIds")
        .and_then(Value::as_array)
        .and_then(|items| items.get(index))
        .and_then(Value::as_str)
        .is_some_and(|configured| configured == item_id)
}

fn black_hole_port_mut(
    target: &mut Map<String, Value>,
    port_index: Option<u8>,
) -> Option<&mut Map<String, Value>> {
    let index = u64::from(port_index?);
    target
        .get_mut("blackHolePorts")
        .and_then(Value::as_array_mut)?
        .iter_mut()
        .filter_map(Value::as_object_mut)
        .find(|port| port.get("index").and_then(Value::as_u64) == Some(index))
}

fn add_black_hole_destroyed(
    target: &mut Map<String, Value>,
    port_index: Option<u8>,
    item_id: &str,
    amount: f64,
) -> anyhow::Result<bool> {
    if !black_hole_active(target) {
        return Ok(false);
    }
    let Some(port) = black_hole_port_mut(target, port_index) else {
        return Ok(false);
    };
    let current = port
        .get("totalDestroyed")
        .and_then(Value::as_str)
        .and_then(|value| BigUint::parse_bytes(value.as_bytes(), 10))
        .unwrap_or_default();
    let moved = amount.floor().max(0.0) as u64;
    port.insert("currentItemId".to_owned(), Value::from(item_id));
    port.insert(
        "totalDestroyed".to_owned(),
        Value::from((current + BigUint::from(moved)).to_string()),
    );
    Ok(true)
}

#[allow(clippy::too_many_arguments)]
fn move_to_target(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entities: &mut [Value],
    quantum_bandwidth: crate::quantum_logistics::RuntimeBandwidth,
    quantum_session: &mut Option<crate::quantum_logistics::SupplyDepositSession>,
    route: &Route,
    item_id: &str,
    requested: f64,
) -> anyhow::Result<f64> {
    let target = entities[route.target_index()]
        .as_object_mut()
        .ok_or_else(|| anyhow!("native belt target is not an object"))?;
    if string_at(target, "buildingId") == Some("micro_black_hole_connector") {
        return Ok(
            if add_black_hole_destroyed(target, route.target_port_index, item_id, requested)? {
                requested
            } else {
                0.0
            },
        );
    }
    if crate::quantum_logistics::is_supply_endpoint(target, item_id) {
        return crate::quantum_logistics::receive_supply_material_in_session(
            state,
            base,
            quantum_bandwidth,
            quantum_session,
            target,
            item_id,
            requested,
        );
    }
    add_input(target, item_id, requested)?;
    Ok(requested)
}

#[inline]
fn queue_target_source_wakes(
    state: &CoreState,
    entities: &[Value],
    prepared_routes: &PreparedRoutes,
    route: &Route,
    item_symbol: u32,
    pending: &mut Vec<u32>,
) -> anyhow::Result<()> {
    if let Some(&group_index) = prepared_routes
        .group_by_key
        .get(&(route.target_index, item_symbol))
    {
        pending.push(group_index);
    }
    let target = entities[route.target_index()]
        .as_object()
        .ok_or_else(|| anyhow!("native belt target is not an object"))?;
    if let Some(recipe) = ordinary_machine_recipe(state, target) {
        for output in &recipe.outputs {
            let Some(output_symbol) = state.symbols.lookup(&output.item_id) else {
                // An unconnected co-product need not be interned in the belt
                // symbol table. With no source/item group there is nothing to
                // wake, and the ordinary production path still accounts for
                // that output through its entity-local buffer.
                continue;
            };
            if let Some(&group_index) = prepared_routes
                .group_by_key
                .get(&(route.target_index, output_symbol))
            {
                pending.push(group_index);
            }
        }
    }
    Ok(())
}

#[inline]
fn record_material_movement(
    changed_entity_indices: &mut Vec<usize>,
    source_index: usize,
    target_index: usize,
    moved: f64,
) {
    if moved > 0.0 {
        changed_entity_indices.push(source_index);
        changed_entity_indices.push(target_index);
    }
}

fn finalize_material_movement_evidence(changed_entity_indices: &mut Vec<usize>) {
    changed_entity_indices.sort_unstable();
    changed_entity_indices.dedup();
}

fn source_produces(state: &CoreState, source: &Map<String, Value>, item_id: &str) -> bool {
    if crate::system_space_station::is_elevator(source) {
        return source
            .get("elevatorOutputItems")
            .and_then(Value::as_array)
            .is_some_and(|items| {
                items
                    .iter()
                    .take(5)
                    .any(|configured| configured.as_str() == Some(item_id))
            });
    }
    match string_at(source, "kind") {
        Some("vein") => string_at(source, "resourceId") == Some(item_id),
        Some("machine" | "power") => string_at(source, "recipeId")
            .and_then(|id| state.catalog.recipes.get(id))
            .is_some_and(|recipe| {
                recipe
                    .outputs
                    .iter()
                    .any(|output| output.item_id == item_id)
            }),
        Some("storage" | "splitter") => string_at(source, "storedItemId") == Some(item_id),
        Some("station") => source
            .get("stationSlots")
            .and_then(Value::as_array)
            .is_some_and(|slots| {
                slots
                    .iter()
                    .filter_map(Value::as_object)
                    .any(|slot| string_at(slot, "itemId") == Some(item_id))
            }),
        _ => false,
    }
}

fn ordinary_machine_recipe<'a>(
    state: &'a CoreState,
    source: &Map<String, Value>,
) -> Option<&'a crate::catalog::RecipeDefinition> {
    // Content packs may attach opaque production behavior to otherwise
    // ordinary-looking rows. Until that behavior supplies its own closed wake
    // proof, retain the historical always-awake fallback. The empty registry
    // fingerprint identifies the built-in catalog on both the checkpoint and
    // the validated runtime snapshot.
    if state.identity.registry_fingerprint != EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT
        || state.catalog.snapshot.registry_fingerprint != EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT
        || string_at(source, "kind") != Some("machine")
        || matches!(
            string_at(source, "buildingId"),
            Some(
                "construction_center"
                    | "time_warp_device"
                    | "ray_receiver"
                    | "galactic_material_exporter"
                    | "micro_black_hole_connector"
            )
        )
    {
        return None;
    }
    let entity_index =
        string_at(source, "id").and_then(|id| state.entity_index.get(id).copied())?;
    if state
        .factory_topology
        .ordinary_machine_indices
        .binary_search(&entity_index)
        .is_err()
    {
        return None;
    }
    let recipe_id = string_at(source, "recipeId")?;
    if matches!(
        recipe_id,
        "matrix_research" | "solar_sail_launch" | "carrier_rocket_launch"
    ) {
        return None;
    }
    state.catalog.recipes.get(recipe_id)
}

fn ordinary_machine_produces(
    state: &CoreState,
    source: &Map<String, Value>,
    item_id: &str,
) -> bool {
    ordinary_machine_recipe(state, source).is_some_and(|recipe| {
        recipe
            .outputs
            .iter()
            .any(|output| output.item_id == item_id)
    })
}

fn ordinary_machine_has_complete_input_cycle(
    state: &CoreState,
    source: &Map<String, Value>,
    item_id: &str,
) -> bool {
    ordinary_machine_recipe(state, source)
        .filter(|recipe| {
            recipe
                .outputs
                .iter()
                .any(|output| output.item_id == item_id)
        })
        .is_some_and(|recipe| {
            let input_cycles = recipe
                .inputs
                .iter()
                .fold(f64::INFINITY, |available, input| {
                    available.min(input_amount(source, &input.item_id) / input.amount)
                });
            (input_cycles + EPSILON).floor() >= 1.0
        })
}

fn source_may_produce_during_step(
    state: &CoreState,
    source: &Map<String, Value>,
    item_id: &str,
) -> bool {
    if string_at(source, "kind") == Some("vein") {
        return string_at(source, "resourceId") == Some(item_id);
    }
    if ordinary_machine_produces(state, source, item_id) {
        // Built-in ordinary machines have a closed reverse dependency below:
        // complete checkpoint inputs seed the group, while a real incoming
        // belt movement wakes every recipe output and catches up this step's
        // belt clock before reservation. They no longer need to stay awake
        // merely because a recipe could produce eventually.
        return false;
    }
    if string_at(source, "recipeId")
        .and_then(|id| state.catalog.recipes.get(id))
        .is_some_and(|recipe| {
            recipe
                .outputs
                .iter()
                .any(|output| output.item_id == item_id)
        })
    {
        return true;
    }
    matches!(
        string_at(source, "buildingId"),
        Some(
            "orbital_collector"
                | "energy_exchanger"
                | "orbital_cargo_terminal"
                | "material_delivery_hub"
        )
    ) || string_at(source, "kind") == Some("station")
}

fn target_consumes(
    state: &CoreState,
    target: &Map<String, Value>,
    item_id: &str,
    target_port_index: Option<u8>,
) -> bool {
    if crate::system_space_station::is_elevator(target) {
        return state.catalog.items.contains_key(item_id);
    }
    if string_at(target, "buildingId") == Some("orbital_cargo_terminal") {
        return crate::orbital_station::terminal_accepts(state, target, item_id, target_port_index);
    }
    if matches!(
        string_at(target, "buildingId"),
        Some("micro_black_hole_connector" | "material_delivery_hub")
    ) {
        return state.catalog.items.contains_key(item_id);
    }
    match string_at(target, "kind") {
        Some("machine" | "power") => {
            let accepts_proliferator = target
                .get("sprayCoaterInstalled")
                .and_then(Value::as_bool)
                .unwrap_or(false)
                && target
                    .get("proliferatorTier")
                    .and_then(Value::as_u64)
                    .and_then(|tier| u8::try_from(tier).ok())
                    .and_then(|tier| state.catalog.proliferators.get(&tier))
                    .is_some_and(|definition| definition.item_id == item_id);
            let accepts_research_matrix = string_at(target, "recipeId") == Some("matrix_research")
                && matches!(
                    item_id,
                    "electromagnetic_matrix"
                        | "energy_matrix"
                        | "structure_matrix"
                        | "information_matrix"
                        | "gravity_matrix"
                        | "universe_matrix"
                );
            let accepts_fuel = string_at(target, "buildingId")
                .and_then(|id| state.catalog.buildings.get(id))
                .is_some_and(|building| {
                    building.fuel_item_ids.iter().any(|id| id == item_id)
                        && string_at(target, "fuelItemId")
                            .is_none_or(|selected| selected == item_id)
                });
            accepts_fuel
                || accepts_proliferator
                || accepts_research_matrix
                || string_at(target, "recipeId")
                    .and_then(|id| state.catalog.recipes.get(id))
                    .is_some_and(|recipe| {
                        recipe.inputs.iter().any(|input| input.item_id == item_id)
                    })
        }
        Some("storage" | "splitter") => {
            if string_at(target, "storedItemId") != Some(item_id) {
                return false;
            }
            let Some(building) =
                string_at(target, "buildingId").and_then(|id| state.catalog.buildings.get(id))
            else {
                return false;
            };
            let item_kind = state
                .catalog
                .items
                .get(item_id)
                .map(|item| item.kind.as_str())
                .unwrap_or_default();
            match building.accepts.as_deref().unwrap_or("any") {
                "any" => true,
                "solid" => matches!(item_kind, "solid" | "matrix"),
                accepted => accepted == item_kind,
            }
        }
        Some("station") => target
            .get("stationSlots")
            .and_then(Value::as_array)
            .is_some_and(|slots| {
                slots
                    .iter()
                    .filter_map(Value::as_object)
                    .any(|slot| string_at(slot, "itemId") == Some(item_id))
            }),
        _ => false,
    }
}

fn target_capacity(
    state: &CoreState,
    base: &Map<String, Value>,
    quantum_session: &mut Option<crate::quantum_logistics::SupplyDepositSession>,
    entities: &[Value],
    target: &Map<String, Value>,
    item_id: &str,
    target_port_index: Option<u8>,
) -> anyhow::Result<f64> {
    if string_at(target, "buildingId") == Some("micro_black_hole_connector") {
        let port_exists = target
            .get("blackHolePorts")
            .and_then(Value::as_array)
            .is_some_and(|ports| {
                ports.iter().filter_map(Value::as_object).any(|port| {
                    port.get("index").and_then(Value::as_u64) == target_port_index.map(u64::from)
                })
            });
        return Ok(if black_hole_active(target) && port_exists {
            9_007_199_254_740_991.0
        } else {
            0.0
        });
    }
    if string_at(target, "buildingId") == Some("material_delivery_hub") {
        if !material_delivery_slot_accepts(target, item_id, target_port_index) {
            return Ok(0.0);
        }
        if matches!(item_id, "logistics_drone" | "logistics_vessel") {
            return Ok(9_007_199_254_740_991.0);
        }
        let planet_id = string_at(target, "planetId").unwrap_or_default();
        let active_planet_id = base
            .get("activePlanetId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let tray = if planet_id == active_planet_id {
            base.get("tray").and_then(Value::as_object)
        } else {
            base.get("planetTrays")
                .and_then(Value::as_object)
                .and_then(|trays| trays.get(planet_id))
                .and_then(Value::as_object)
        };
        let current = tray
            .and_then(|tray| tray.get(item_id))
            .map(|value| finite_number(Some(value)).floor())
            .unwrap_or(0.0);
        let limit = base
            .get("planetTrayItemLimits")
            .and_then(Value::as_object)
            .and_then(|limits| limits.get(planet_id))
            .map(|value| {
                finite_number(Some(value))
                    .floor()
                    .clamp(1_000.0, 100_000_000.0)
            })
            .unwrap_or(1_000_000.0);
        let pending = state
            .factory_topology
            .material_delivery_hub_indices
            .iter()
            .filter_map(|&index| entities[index].as_object())
            .filter(|entity| string_at(entity, "planetId") == Some(planet_id))
            .map(|entity| input_amount(entity, item_id).floor().max(0.0))
            .sum::<f64>();
        return Ok((limit - current - pending).max(0.0));
    }
    if let Some(capacity) = crate::quantum_logistics::supply_free_capacity_in_session(
        state,
        base,
        quantum_session,
        target,
        item_id,
    )? {
        return Ok(capacity);
    }
    let building = string_at(target, "buildingId")
        .and_then(|id| state.catalog.buildings.get(id))
        .ok_or_else(|| anyhow!("native belt target building is missing"))?;
    let logistics = matches!(
        string_at(target, "kind"),
        Some("storage" | "splitter" | "station")
    );
    let limit = normalized_buffer_limit(base.get("settings").and_then(Value::as_object).and_then(
        |settings| {
            settings.get(if logistics {
                "logisticsBufferLimit"
            } else {
                "productionBufferLimit"
            })
        },
    ));
    let mut capacity = stacked_capacity(
        if string_at(target, "kind") == Some("station") {
            building.output_capacity
        } else {
            building.input_capacity
        },
        finite_number(target.get("machineCount")),
        limit,
    );
    if target
        .get("sprayCoaterInstalled")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        && target
            .get("proliferatorTier")
            .and_then(Value::as_u64)
            .and_then(|tier| u8::try_from(tier).ok())
            .and_then(|tier| state.catalog.proliferators.get(&tier))
            .is_some_and(|definition| definition.item_id == item_id)
    {
        let proliferator_limit = base
            .get("settings")
            .and_then(Value::as_object)
            .and_then(|settings| settings.get("proliferatorBufferLimit"))
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite())
            .unwrap_or(600.0)
            .floor()
            .clamp(1.0, 100_000_000.0);
        capacity = capacity.min(proliferator_limit);
    }
    if string_at(target, "kind") == Some("station")
        && let Some(max_stock) = target
            .get("stationSlots")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_object)
            .find(|slot| string_at(slot, "itemId") == Some(item_id))
            .map(|slot| finite_number(slot.get("maxStock")).floor().max(0.0))
            .filter(|value| *value > 0.0)
    {
        capacity = capacity.min(max_stock);
    }
    Ok(capacity - input_amount(target, item_id))
}

fn target_capacity_for_route(
    state: &CoreState,
    base: &Map<String, Value>,
    entities: &[Value],
    prepared_routes: &PreparedRoutes,
    route_index: usize,
    quantum_session: &mut Option<crate::quantum_logistics::SupplyDepositSession>,
) -> anyhow::Result<f64> {
    let route = prepared_routes
        .routes
        .get(route_index)
        .ok_or_else(|| anyhow!("native belt target-capacity route is outside the topology"))?;
    let prepared_group = prepared_routes
        .groups
        .get(route.source_group())
        .ok_or_else(|| anyhow!("native belt target-capacity group is outside the topology"))?;
    let item_id = state
        .symbols
        .resolve(prepared_group.item_symbol)
        .ok_or_else(|| anyhow!("native prepared belt item is missing"))?;
    let target = entities
        .get(route.target_index())
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native belt target is not an object"))?;
    Ok(target_capacity(
        state,
        base,
        quantum_session,
        entities,
        target,
        item_id,
        route.target_port_index,
    )?
    .floor()
    .max(0.0))
}

fn resolve_target_capacity_plan_with_runtime<Session, NewSession, Probe>(
    prepared_routes: &PreparedRoutes,
    plan: &[TargetCapacityPlanEntry],
    target_free: &mut [f64],
    serial_session: &mut Session,
    executor: &DeterministicRuntime,
    new_private_session: NewSession,
    probe: Probe,
) -> anyhow::Result<TargetCapacityPlanDiagnostics>
where
    Session: Send,
    NewSession: Fn() -> Session + Sync,
    Probe: Fn(usize, &mut Session) -> anyhow::Result<f64> + Sync,
{
    let worker_count = if plan.is_empty() {
        0
    } else {
        executor.worker_count_for_items(plan.len())
    };
    if plan.is_empty() {
        return Ok(TargetCapacityPlanDiagnostics::default());
    }

    let apply_capacity = |entry: &TargetCapacityPlanEntry,
                          capacity: f64,
                          target_free: &mut [f64]|
     -> anyhow::Result<()> {
        if !capacity.is_finite() || capacity < 0.0 {
            bail!("native belt target capacity is invalid");
        }
        let route_index = expand_compact_index(entry.route_index);
        let target_slot = prepared_routes
            .routes
            .get(route_index)
            .ok_or_else(|| anyhow!("native belt target-capacity route is outside the topology"))?
            .target_slot();
        *target_free.get_mut(target_slot).ok_or_else(|| {
            anyhow!("native belt target-capacity slot is outside the workspace")
        })? = capacity;
        Ok(())
    };

    if worker_count == 1 {
        for entry in plan {
            let capacity = probe(expand_compact_index(entry.route_index), serial_session)?;
            apply_capacity(entry, capacity, target_free)?;
        }
    } else {
        // Fixed ascending chunks own private probe sessions. Workers never
        // observe the shared target ledger, quantum deposit session, or entity
        // writes; indexed chunk collection and this replay retain the exact
        // first-use route order and first stable error.
        let chunk_results =
            executor.ordered_chunk_map(plan.len(), TARGET_CAPACITY_ROWS_PER_CHUNK, |_, range| {
                let mut private_session = new_private_session();
                range
                    .map(|plan_index| {
                        probe(
                            expand_compact_index(plan[plan_index].route_index),
                            &mut private_session,
                        )
                    })
                    .collect::<Vec<_>>()
            });
        let mut results = chunk_results.into_iter().flatten();
        for entry in plan {
            let capacity = results
                .next()
                .ok_or_else(|| anyhow!("native belt target-capacity result is missing"))??;
            apply_capacity(entry, capacity, target_free)?;
        }
        if results.next().is_some() {
            bail!("native belt target-capacity result count changed");
        }
    }

    Ok(TargetCapacityPlanDiagnostics {
        component_count: plan.len(),
        parallel_component_count: if worker_count == 1 { 0 } else { plan.len() },
        serial_component_count: if worker_count == 1 { plan.len() } else { 0 },
        worker_count,
    })
}

fn build_transfer_target_capacity_plan(
    prepared_routes: &PreparedRoutes,
    selection: &ActiveSelection,
    groups: &[Group],
    target_free: &mut [f64],
    touched_target_slots: &mut Vec<u32>,
) -> anyhow::Result<Vec<TargetCapacityPlanEntry>> {
    if target_free.len() != expand_compact_index(prepared_routes.target_slot_count) {
        bail!("native belt target-capacity workspace changed");
    }

    let mut plan = Vec::<TargetCapacityPlanEntry>::new();
    for group_index in selection.group_indices(prepared_routes.groups.len()) {
        let group = groups
            .get(group_index)
            .ok_or_else(|| anyhow!("native belt target-capacity group is outside the runtime"))?;
        if group.available < 1.0 {
            continue;
        }
        let prepared_group = prepared_routes
            .groups
            .get(group_index)
            .ok_or_else(|| anyhow!("native belt target-capacity group is outside the topology"))?;
        for route_index in prepared_group.route_indices.iter().copied() {
            let route_index_expanded = expand_compact_index(route_index);
            let route = prepared_routes
                .routes
                .get(route_index_expanded)
                .ok_or_else(|| {
                    anyhow!("native belt target-capacity route is outside the topology")
                })?;
            let target_slot = route.target_slot();
            let target_free_slot = target_free.get_mut(target_slot).ok_or_else(|| {
                anyhow!("native belt target-capacity slot is outside the workspace")
            })?;
            if !target_free_slot.is_nan() {
                continue;
            }

            // Reserve the component before any worker starts so duplicate
            // routes can never schedule two probes for one shared capacity.
            // The slot is restored to a finite value in stable plan order.
            *target_free_slot = f64::NEG_INFINITY;
            touched_target_slots.push(compact_index(target_slot, "target-capacity touched slot")?);

            plan.push(TargetCapacityPlanEntry { route_index });
        }
    }
    Ok(plan)
}

#[allow(clippy::too_many_arguments)]
fn prepare_transfer_target_capacities_with_runtime(
    state: &CoreState,
    base: &Map<String, Value>,
    entities: &[Value],
    prepared_routes: &PreparedRoutes,
    selection: &ActiveSelection,
    groups: &[Group],
    target_free: &mut [f64],
    touched_target_slots: &mut Vec<u32>,
    quantum_session: &mut Option<crate::quantum_logistics::SupplyDepositSession>,
    executor: &DeterministicRuntime,
) -> anyhow::Result<TargetCapacityPlanDiagnostics> {
    let profile_enabled = std::env::var_os("DSP_NATIVE_CORE_PROFILE").is_some();
    let plan_started = profile_enabled.then(std::time::Instant::now);
    let plan = build_transfer_target_capacity_plan(
        prepared_routes,
        selection,
        groups,
        target_free,
        touched_target_slots,
    )?;
    if let Some(started) = plan_started {
        eprintln!(
            "DSP_NATIVE_CORE_PROFILE\tbelt-transfer-target-capacity-build-plan\t{:.3}",
            started.elapsed().as_secs_f64() * 1_000.0
        );
    }
    resolve_target_capacity_plan_with_runtime(
        prepared_routes,
        &plan,
        target_free,
        quantum_session,
        executor,
        || None,
        |route_index, session| {
            target_capacity_for_route(state, base, entities, prepared_routes, route_index, session)
        },
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ReservationTargetCapacityPolicy {
    reuse_cached: bool,
}

fn reservation_target_capacity_policy(
    state: &CoreState,
    entities: &[Value],
    prepared_routes: &PreparedRoutes,
    route_index: usize,
) -> anyhow::Result<ReservationTargetCapacityPolicy> {
    let route = prepared_routes
        .routes
        .get(route_index)
        .ok_or_else(|| anyhow!("native belt reservation route is outside the topology"))?;
    let target = entities
        .get(route.target_index())
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native belt target is not an object"))?;
    let prepared_group = prepared_routes
        .groups
        .get(route.source_group())
        .ok_or_else(|| anyhow!("native belt reservation group is outside the topology"))?;
    let item_id = state
        .symbols
        .resolve(prepared_group.item_symbol)
        .ok_or_else(|| anyhow!("native prepared belt item is missing"))?;
    let quantum_supply = crate::quantum_logistics::is_supply_endpoint(target, item_id);
    let building_id = string_at(target, "buildingId");
    // A quantum supply slot includes one shared network balance, so another
    // station can invalidate a capacity computed by the input transfer. An
    // orbital terminal's topology slot is port-specific while its persisted
    // input balance is entity/item-specific, so a sibling port can do the
    // same. The two unbounded sinks report MAX_SAFE capacity independently
    // of the material just moved, so their decremented workspace value is not
    // a reusable physical-capacity snapshot. Every remaining target-slot key
    // fully owns the finite capacity it consumed during the immediately
    // preceding input transfer.
    let unbounded_sink = building_id == Some("micro_black_hole_connector")
        || (building_id == Some("material_delivery_hub")
            && matches!(item_id, "logistics_drone" | "logistics_vessel"));
    let reuse_cached =
        !quantum_supply && building_id != Some("orbital_cargo_terminal") && !unbounded_sink;
    Ok(ReservationTargetCapacityPolicy { reuse_cached })
}

fn build_reservation_target_capacity_plan(
    prepared_routes: &PreparedRoutes,
    selection: &ActiveSelection,
    target_free: &mut [f64],
    touched_target_slots: &mut Vec<u32>,
    mut route_allowance: impl FnMut(usize) -> anyhow::Result<f64>,
    mut route_policy: impl FnMut(usize) -> anyhow::Result<ReservationTargetCapacityPolicy>,
) -> anyhow::Result<Vec<TargetCapacityPlanEntry>> {
    if target_free.len() != expand_compact_index(prepared_routes.target_slot_count) {
        bail!("native belt reservation target-capacity workspace changed");
    }

    let mut plan = Vec::<TargetCapacityPlanEntry>::new();
    for route_index in selection.route_indices(prepared_routes.routes.len()) {
        let allowance = route_allowance(route_index)?;
        if allowance < 1.0 {
            continue;
        }
        let route = prepared_routes
            .routes
            .get(route_index)
            .ok_or_else(|| anyhow!("native belt reservation route is outside the topology"))?;
        let target_slot = route.target_slot();
        let current = *target_free.get(target_slot).ok_or_else(|| {
            anyhow!("native belt reservation target slot is outside the workspace")
        })?;
        // NEG_INFINITY is the private first-use marker installed by this
        // builder. It prevents duplicate routes from scheduling the same
        // target component while no worker can observe mutable workspace.
        if current.is_infinite() && current.is_sign_negative() {
            continue;
        }
        if !current.is_nan() && (!current.is_finite() || current < 0.0) {
            bail!("native belt reservation cached target capacity is invalid");
        }

        let policy = route_policy(route_index)?;
        if current.is_finite() && policy.reuse_cached {
            continue;
        }
        if current.is_nan() {
            touched_target_slots.push(compact_index(
                target_slot,
                "reservation target-capacity touched slot",
            )?);
        }
        target_free[target_slot] = f64::NEG_INFINITY;
        plan.push(TargetCapacityPlanEntry {
            route_index: compact_index(
                route_index,
                "reservation target-capacity plan route index",
            )?,
        });
    }
    Ok(plan)
}

#[allow(clippy::too_many_arguments)]
fn resolve_reservation_target_capacity_plan_with_runtime(
    state: &CoreState,
    base: &Map<String, Value>,
    entities: &[Value],
    prepared_routes: &PreparedRoutes,
    plan: &[TargetCapacityPlanEntry],
    target_free: &mut [f64],
    quantum_session: &mut Option<crate::quantum_logistics::SupplyDepositSession>,
    executor: &DeterministicRuntime,
) -> anyhow::Result<TargetCapacityPlanDiagnostics> {
    resolve_target_capacity_plan_with_runtime(
        prepared_routes,
        plan,
        target_free,
        quantum_session,
        executor,
        || None,
        |route_index, session| {
            target_capacity_for_route(state, base, entities, prepared_routes, route_index, session)
        },
    )
}

#[allow(clippy::too_many_arguments)]
fn prepare_reservation_target_capacities_with_runtime(
    state: &CoreState,
    base: &Map<String, Value>,
    entities: &[Value],
    prepared_routes: &PreparedRoutes,
    selection: &ActiveSelection,
    progress: &BeltPagedColumn<f64>,
    target_free: &mut [f64],
    touched_target_slots: &mut Vec<u32>,
    quantum_session: &mut Option<crate::quantum_logistics::SupplyDepositSession>,
    executor: &DeterministicRuntime,
) -> anyhow::Result<TargetCapacityPlanDiagnostics> {
    let plan = build_reservation_target_capacity_plan(
        prepared_routes,
        selection,
        target_free,
        touched_target_slots,
        |route_index| Ok((progress[route_index] + EPSILON).floor().max(0.0)),
        |route_index| {
            reservation_target_capacity_policy(state, entities, prepared_routes, route_index)
        },
    )?;
    resolve_reservation_target_capacity_plan_with_runtime(
        state,
        base,
        entities,
        prepared_routes,
        &plan,
        target_free,
        quantum_session,
        executor,
    )
}

fn route_from_record(
    state: &CoreState,
    entities: &[Value],
    belt: &Map<String, Value>,
) -> anyhow::Result<Route> {
    let source_id =
        string_at(belt, "source").ok_or_else(|| anyhow!("native belt source is missing"))?;
    let target_id =
        string_at(belt, "target").ok_or_else(|| anyhow!("native belt target is missing"))?;
    let source_index = *state
        .entity_index
        .get(source_id)
        .ok_or_else(|| anyhow!("native belt source does not exist"))?;
    let target_index = *state
        .entity_index
        .get(target_id)
        .ok_or_else(|| anyhow!("native belt target does not exist"))?;
    if source_index >= entities.len() || target_index >= entities.len() {
        bail!("native belt route index is outside the entity table");
    }
    let tier = belt
        .get("tier")
        .and_then(Value::as_u64)
        .and_then(|value| u8::try_from(value).ok())
        .ok_or_else(|| anyhow!("native belt tier is invalid"))?;
    let speed = state
        .catalog
        .belt_speeds
        .get(&tier)
        .copied()
        .ok_or_else(|| anyhow!("native belt tier is not in the catalog"))?;
    let (lanes, stack_size) = persisted_belt_dimensions(belt);
    let target_port_index = belt
        .get("targetPortIndex")
        .and_then(Value::as_u64)
        .and_then(|value| u8::try_from(value).ok());
    let _ = string_at(belt, "id").ok_or_else(|| anyhow!("native belt ID is missing"))?;
    Ok(Route {
        capacity: speed * lanes * stack_size,
        source_index: compact_index(source_index, "source entity index")?,
        target_index: compact_index(target_index, "target entity index")?,
        source_group: 0,
        target_slot: 0,
        belt_sort_rank: 0,
        target_port_index,
        priority: u8::try_from(
            belt.get("priority")
                .and_then(Value::as_u64)
                .unwrap_or(1)
                .min(2),
        )
        .context("native belt priority exceeds its compact limit")?,
    })
}

fn prepare_routes_from_rows(
    state: &CoreState,
    entities: &[Value],
    mut routes: Vec<Route>,
) -> anyhow::Result<PreparedRoutes> {
    if routes.len() != state.belts.ids.len() || routes.len() != state.belts.items.len() {
        bail!("native belt prepared route topology changed");
    }
    compact_index(routes.len(), "route count")?;
    compact_index(entities.len(), "entity count")?;
    let mut total_capacity = 0.0;
    for route in &routes {
        total_capacity += route.capacity;
    }
    if !total_capacity.is_finite() {
        bail!("native belt aggregate is non-finite");
    }
    let mut group_by_key = HashMap::<(u32, u32), u32>::new();
    let mut target_slot_by_key = HashMap::<TargetSlotKey, u32>::new();
    let mut groups = Vec::<PreparedGroup>::new();
    let mut group_route_indices = Vec::<Vec<u32>>::new();
    for (route_index, route) in routes.iter_mut().enumerate() {
        let item_symbol = state.belts.items[route_index];
        let group_key = (route.source_index, item_symbol);
        let source_group = if let Some(&source_group) = group_by_key.get(&group_key) {
            source_group
        } else {
            let source = entities[route.source_index()]
                .as_object()
                .expect("validated belt source");
            let source_group = compact_index(groups.len(), "source group index")?;
            groups.push(PreparedGroup {
                source_index: route.source_index,
                item_symbol,
                balanced_splitter: string_at(source, "kind") == Some("splitter")
                    && string_at(source, "distributionMode") != Some("priority"),
                always_awake: source_may_produce_during_step(
                    state,
                    source,
                    state.symbols.resolve(item_symbol).unwrap_or_default(),
                ),
                route_indices: Box::default(),
            });
            group_route_indices.push(Vec::new());
            group_by_key.insert(group_key, source_group);
            source_group
        };
        route.source_group = source_group;
        group_route_indices[expand_compact_index(source_group)]
            .push(compact_index(route_index, "route index")?);
        let target = entities[route.target_index()]
            .as_object()
            .expect("validated belt target");
        let target_key = if string_at(target, "buildingId") == Some("micro_black_hole_connector") {
            TargetSlotKey::BlackHole {
                target_index: route.target_index,
                port: route.target_port_index.map_or(-1_i16, i16::from),
            }
        } else if string_at(target, "buildingId") == Some("material_delivery_hub") {
            TargetSlotKey::Tray {
                planet: state.entities.planets[route.target_index()],
                item: item_symbol,
            }
        } else if string_at(target, "buildingId") == Some("orbital_cargo_terminal") {
            TargetSlotKey::OrbitalCargo {
                target_index: route.target_index,
                item: item_symbol,
                port: route.target_port_index.map_or(-1_i16, i16::from),
            }
        } else {
            TargetSlotKey::Entity {
                target_index: route.target_index,
                item: item_symbol,
            }
        };
        route.target_slot = if let Some(&target_slot) = target_slot_by_key.get(&target_key) {
            target_slot
        } else {
            let target_slot = compact_index(target_slot_by_key.len(), "target slot index")?;
            target_slot_by_key.insert(target_key, target_slot);
            target_slot
        };
    }
    for (group, route_indices) in groups.iter_mut().zip(group_route_indices) {
        group.route_indices = route_indices.into_boxed_slice();
    }
    sort_prepared_group_routes(&mut routes, &mut groups, &state.belts.ids)?;
    routes.shrink_to_fit();
    groups.shrink_to_fit();
    group_by_key.shrink_to_fit();
    Ok(PreparedRoutes {
        routes,
        groups,
        target_slot_count: compact_index(target_slot_by_key.len(), "target slot count")?,
        total_capacity,
        group_by_key: Arc::new(group_by_key),
    })
}

pub(crate) fn prepare_routes_from_state(
    state: &CoreState,
    entities: &[Value],
) -> anyhow::Result<PreparedRoutes> {
    if entities.len() != state.entities.ids.len() {
        bail!("native belt route entity topology changed");
    }
    compact_index(entities.len(), "entity count")?;
    compact_index(state.belts.ids.len(), "route count")?;
    let mut routes = Vec::with_capacity(state.belts.ids.len());
    for belt_index in 0..state.belts.ids.len() {
        let belt = state.parse_belt(belt_index)?;
        let belt = belt
            .as_object()
            .ok_or_else(|| anyhow!("native belt record is not an object"))?;
        routes.push(route_from_record(state, entities, belt)?);
    }
    prepare_routes_from_rows(state, entities, routes)
}

pub(crate) fn admission_reason_with_entities(
    state: &CoreState,
    entities: &[Value],
) -> anyhow::Result<Option<&'static str>> {
    if state.belt_index.is_empty() {
        return Ok(None);
    }
    if entities.len() != state.entity_index.len() {
        bail!("native belt admission entity topology changed");
    }
    for belt_index in 0..state.belt_index.len() {
        let belt = state.parse_belt(belt_index)?;
        let Some(belt) = belt.as_object() else {
            return Ok(Some("ordinary-belt-record-invalid"));
        };
        let Some(source_id) = string_at(belt, "source") else {
            return Ok(Some("ordinary-belt-endpoint-invalid"));
        };
        let Some(target_id) = string_at(belt, "target") else {
            return Ok(Some("ordinary-belt-endpoint-invalid"));
        };
        let Some(item_id) = string_at(belt, "itemId") else {
            return Ok(Some("ordinary-belt-item-invalid"));
        };
        let (Some(&source_index), Some(&target_index)) = (
            state.entity_index.get(source_id),
            state.entity_index.get(target_id),
        ) else {
            return Ok(Some("ordinary-belt-endpoint-invalid"));
        };
        if source_index == target_index {
            return Ok(Some("ordinary-belt-endpoint-invalid"));
        }
        let source = entities[source_index]
            .as_object()
            .expect("validated entity");
        let target = entities[target_index]
            .as_object()
            .expect("validated entity");
        let target_port_index = belt
            .get("targetPortIndex")
            .and_then(Value::as_u64)
            .and_then(|value| u8::try_from(value).ok());
        let elevator_output_index = belt
            .get("elevatorOutputIndex")
            .and_then(Value::as_u64)
            .and_then(|value| u8::try_from(value).ok());
        if crate::system_space_station::is_elevator(source) {
            if elevator_output_index.is_some_and(|index| {
                index > 4
                    || source
                        .get("elevatorOutputItems")
                        .and_then(Value::as_array)
                        .and_then(|items| items.get(usize::from(index)))
                        .and_then(Value::as_str)
                        != Some(item_id)
            }) {
                return Ok(Some("elevator-belt-output-port-invalid"));
            }
        } else if belt
            .get("elevatorOutputIndex")
            .is_some_and(|value| !value.is_null())
        {
            return Ok(Some("ordinary-belt-special-port-unsupported"));
        }
        if string_at(target, "buildingId") == Some("micro_black_hole_connector") {
            let valid_port = target_port_index.is_some_and(|index| index <= 2)
                && target
                    .get("blackHolePorts")
                    .and_then(Value::as_array)
                    .is_some_and(|ports| {
                        ports.iter().filter_map(Value::as_object).any(|port| {
                            port.get("index").and_then(Value::as_u64)
                                == target_port_index.map(u64::from)
                        })
                    });
            if !valid_port {
                return Ok(Some("black-hole-belt-port-invalid"));
            }
        } else if string_at(target, "buildingId") == Some("material_delivery_hub") {
            if !material_delivery_slot_accepts(target, item_id, target_port_index) {
                return Ok(Some("material-delivery-belt-port-invalid"));
            }
        } else if string_at(target, "buildingId") == Some("orbital_cargo_terminal") {
            if !crate::orbital_station::terminal_accepts(state, target, item_id, target_port_index)
            {
                return Ok(Some("orbital-cargo-belt-port-invalid"));
            }
        } else if belt
            .get("targetPortIndex")
            .is_some_and(|value| !value.is_null())
        {
            return Ok(Some("ordinary-belt-special-port-unsupported"));
        }
        let planet = string_at(belt, "planetId");
        if planet != string_at(source, "planetId") || planet != string_at(target, "planetId") {
            return Ok(Some("ordinary-belt-planet-invalid"));
        }
        if !source_produces(state, source, item_id)
            || !target_consumes(state, target, item_id, target_port_index)
        {
            return Ok(Some("ordinary-belt-route-unsupported"));
        }
        let tier = belt
            .get("tier")
            .and_then(Value::as_u64)
            .and_then(|value| u8::try_from(value).ok());
        let lanes = belt
            .get("lanes")
            .map(|value| finite_number(Some(value)))
            .unwrap_or(1.0);
        let stack_size = belt
            .get("stackSize")
            .map_or(1.0, |value| finite_number(Some(value)));
        let priority = belt.get("priority").and_then(Value::as_u64).unwrap_or(1);
        if tier.is_none_or(|tier| !state.catalog.belt_speeds.contains_key(&tier))
            || lanes < 1.0
            || lanes.fract().abs() > EPSILON
            || stack_size < 1.0
            || stack_size.fract().abs() > EPSILON
            || priority > 2
            || !state.catalog.items.contains_key(item_id)
        {
            return Ok(Some("ordinary-belt-definition-invalid"));
        }
    }
    Ok(None)
}

pub(crate) fn admission_reason(state: &CoreState) -> anyhow::Result<Option<&'static str>> {
    let entities = state.parse_entities_parallel()?;
    admission_reason_with_entities(state, &entities)
}

fn reset_belt_source_snapshots_with_runtime<'a, ResolveItem>(
    entities: &[Value],
    prepared_routes: &PreparedRoutes,
    selection: &ActiveSelection,
    groups: &mut [Group],
    executor: &DeterministicRuntime,
    resolve_item: ResolveItem,
) -> anyhow::Result<()>
where
    ResolveItem: Fn(u32) -> Option<&'a str> + Send + Sync,
{
    let group_count = prepared_routes.groups.len();
    let selected_group_count = selection.selected_groups(group_count);
    if executor.worker_count_for_items(selected_group_count) == 1 {
        // Keep the one-worker path identical to the legacy persisted-order
        // loop: resolve, probe, and reset each selected group immediately.
        for group_index in selection.group_indices(group_count) {
            let group = &mut groups[group_index];
            let prepared_group = &prepared_routes.groups[group_index];
            let item_id = resolve_item(prepared_group.item_symbol)
                .ok_or_else(|| anyhow!("native prepared belt item is missing"))?;
            let source = entities[expand_compact_index(prepared_group.source_index)]
                .as_object()
                .expect("validated source");
            group.reset(
                (output_amount(source, item_id) + EPSILON).floor(),
                source
                    .get("outputs")
                    .and_then(Value::as_object)
                    .is_some_and(|outputs| outputs.contains_key(item_id)),
            );
        }
        return Ok(());
    }

    // Source rows are immutable probes. Fixed ascending chunks may therefore
    // read them in private workers; ordered collection and this serial replay
    // retain the exact group order, lowest failing symbol, and workspace
    // mutation boundary of the one-worker loop.
    let chunk_results = executor.ordered_chunk_map(
        selected_group_count,
        SOURCE_SNAPSHOT_ROWS_PER_CHUNK,
        |_, range| {
            range
                .map(|selected_index| {
                    let group_index = selection.group_index_at(selected_index);
                    let prepared_group = &prepared_routes.groups[group_index];
                    let item_id = resolve_item(prepared_group.item_symbol)
                        .ok_or_else(|| anyhow!("native prepared belt item is missing"))?;
                    let source = entities[expand_compact_index(prepared_group.source_index)]
                        .as_object()
                        .expect("validated source");
                    Ok(BeltSourceSnapshot {
                        group_index,
                        available: (output_amount(source, item_id) + EPSILON).floor(),
                        source_had_output: source
                            .get("outputs")
                            .and_then(Value::as_object)
                            .is_some_and(|outputs| outputs.contains_key(item_id)),
                    })
                })
                .collect::<Vec<anyhow::Result<BeltSourceSnapshot>>>()
        },
    );
    let mut snapshots = chunk_results.into_iter().flatten();
    for expected_group_index in selection.group_indices(group_count) {
        let snapshot = snapshots
            .next()
            .ok_or_else(|| anyhow!("native belt source snapshot result is missing"))??;
        if snapshot.group_index != expected_group_index {
            bail!("native belt source snapshot order changed");
        }
        groups[expected_group_index].reset(snapshot.available, snapshot.source_had_output);
    }
    if snapshots.next().is_some() {
        bail!("native belt source snapshot result count changed");
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn transfer_with_bandwidth(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entities: &mut [Value],
    belt_runtime: &mut BeltRuntime,
    prepared_routes: &PreparedRoutes,
    quantum_bandwidth: crate::quantum_logistics::RuntimeBandwidth,
    seconds: f64,
    defer_source_depletion_reset: bool,
    reservation: Option<&BeltStepReservation>,
    flow_window_seconds: f64,
    changed_entity_indices: &mut Vec<usize>,
) -> anyhow::Result<()> {
    changed_entity_indices.clear();
    if belt_runtime.progress.is_empty() {
        return Ok(());
    }
    let mut profiler = BeltTransferProfiler::new();
    let routes = &prepared_routes.routes;
    let mut quantum_session = None;
    let belt_limit = normalized_buffer_limit(
        base.get("settings")
            .and_then(Value::as_object)
            .and_then(|settings| settings.get("beltBufferLimit")),
    );
    with_active_selection(belt_runtime, prepared_routes, |belt_runtime, selection| {
        belt_runtime.record_selection(prepared_routes, selection, false);
        advance_belt_clocks(
            belt_runtime,
            prepared_routes,
            selection,
            seconds,
            belt_limit,
        )?;
        profiler.mark("belt-transfer-select-and-clock");
        let progress = &belt_runtime.progress;
        belt_runtime
            .workspace
            .reset_transfer_buffers(prepared_routes, selection);
        let BeltWorkspace {
            post_actions,
            target_free,
            touched_target_slots,
            groups,
            usable_candidate_indices,
            active_candidate_indices,
            pending_wake_group_indices,
            ..
        } = &mut belt_runtime.workspace;
        debug_assert_eq!(groups.len(), prepared_routes.groups.len());
        reset_belt_source_snapshots_with_runtime(
            entities,
            prepared_routes,
            selection,
            groups,
            deterministic_runtime(),
            |item_symbol| state.symbols.resolve(item_symbol),
        )?;
        profiler.mark("belt-transfer-source-snapshot");

        let target_capacity_diagnostics = prepare_transfer_target_capacities_with_runtime(
            state,
            base,
            entities,
            prepared_routes,
            selection,
            groups,
            target_free,
            touched_target_slots,
            &mut quantum_session,
            deterministic_runtime(),
        )?;
        profiler.mark("belt-transfer-target-capacity-plan");
        profiler.target_capacity_plan(target_capacity_diagnostics);

        for index in selection.group_indices(prepared_routes.groups.len()) {
            for route_index in prepared_routes.groups[index]
                .route_indices
                .iter()
                .copied()
                .map(expand_compact_index)
            {
                let route = &routes[route_index];
                if groups[index].available < 1.0 {
                    if !defer_source_depletion_reset {
                        post_actions[route_index] = BeltPostAction::ResetProgress;
                    }
                    continue;
                }
                let target_slot = route.target_slot();
                if !target_free[target_slot].is_finite() {
                    bail!("native belt target-capacity plan is incomplete");
                }
                if target_free[target_slot] < 1.0 {
                    post_actions[route_index] = BeltPostAction::ResetProgress;
                    continue;
                }
                let cap = reservation
                    .and_then(|reservation| {
                        reservation
                            .allowance_by_belt
                            .get(&u32::try_from(route_index).ok()?)
                            .copied()
                    })
                    .filter(|value| value.is_finite())
                    .unwrap_or(9_007_199_254_740_991.0);
                let allowance = (progress[route_index] + EPSILON).floor().min(cap);
                if allowance < 1.0 {
                    if groups[index].first_inactive_route.is_none() {
                        groups[index].first_inactive_route = Some(route_index);
                    } else {
                        groups[index].inactive_routes.push(route_index);
                    }
                    continue;
                }
                let candidate = Candidate {
                    route_index,
                    allowance,
                    moved: 0.0,
                };
                if groups[index].first_candidate.is_none() {
                    groups[index].first_candidate = Some(candidate);
                } else {
                    groups[index].candidates.push(candidate);
                }
            }
        }
        profiler.mark("belt-transfer-candidate-scan");

        // These persistent scratch buffers retain the canonical candidate order;
        // cursor rotation and every floating point operation therefore remain
        // byte-for-byte equivalent across workspace reuse.
        for group_index in selection.group_indices(prepared_routes.groups.len()) {
            let group = &mut groups[group_index];
            let prepared_group = &prepared_routes.groups[group_index];
            let item_id = state
                .symbols
                .resolve(prepared_group.item_symbol)
                .ok_or_else(|| anyhow!("native prepared belt item is missing"))?;
            let Some(first_candidate) = group.first_candidate.take() else {
                if group.source_had_output || group.available > 0.0 {
                    set_output(
                        entities[expand_compact_index(prepared_group.source_index)]
                            .as_object_mut()
                            .ok_or_else(|| anyhow!("native belt source is not an object"))?,
                        item_id,
                        group.available,
                    )?;
                }
                for route_index in group
                    .first_inactive_route
                    .iter()
                    .copied()
                    .chain(group.inactive_routes.iter().copied())
                {
                    let route = &routes[route_index];
                    post_actions[route_index] = BeltPostAction::Flow {
                        available: group.available,
                        free: target_free[route.target_slot()],
                        moved: 0.0,
                    };
                }
                continue;
            };
            if group.candidates.is_empty() {
                let route = &routes[first_candidate.route_index];
                let target_slot = route.target_slot();
                let free = target_free[target_slot];
                let requested = group
                    .available
                    .min(first_candidate.allowance)
                    .min(free)
                    .floor()
                    .max(0.0);
                let moved = if requested > 0.0 {
                    move_to_target(
                        state,
                        base,
                        entities,
                        quantum_bandwidth,
                        &mut quantum_session,
                        route,
                        item_id,
                        requested,
                    )?
                } else {
                    0.0
                };
                let available = (group.available - moved).max(0.0);
                if moved > 0.0 {
                    record_material_movement(
                        changed_entity_indices,
                        expand_compact_index(prepared_group.source_index),
                        route.target_index(),
                        moved,
                    );
                    target_free[target_slot] -= moved;
                    queue_target_source_wakes(
                        state,
                        entities,
                        prepared_routes,
                        route,
                        prepared_group.item_symbol,
                        pending_wake_group_indices,
                    )?;
                    set_number(
                        entities[expand_compact_index(prepared_group.source_index)]
                            .as_object_mut()
                            .ok_or_else(|| anyhow!("native belt source is not an object"))?,
                        "routingCursor",
                        0.0,
                    )?;
                }
                if group.source_had_output || group.available > 0.0 {
                    set_output(
                        entities[expand_compact_index(prepared_group.source_index)]
                            .as_object_mut()
                            .ok_or_else(|| anyhow!("native belt source is not an object"))?,
                        item_id,
                        available,
                    )?;
                }
                post_actions[first_candidate.route_index] = BeltPostAction::Flow {
                    available,
                    free: target_free[target_slot],
                    moved,
                };
                for route_index in group
                    .first_inactive_route
                    .iter()
                    .copied()
                    .chain(group.inactive_routes.iter().copied())
                {
                    let inactive_route = &routes[route_index];
                    post_actions[route_index] = BeltPostAction::Flow {
                        available,
                        free: target_free[inactive_route.target_slot()],
                        moved: 0.0,
                    };
                }
                continue;
            }
            group.candidates.push(first_candidate);
            group
                .candidates
                .sort_by_key(|candidate| routes[candidate.route_index].belt_sort_rank());
            let mut available = group.available;
            let priorities: &[u8] =
                if group.candidates.len() == 1 || prepared_group.balanced_splitter {
                    &[3]
                } else {
                    &[2, 1, 0]
                };
            for &priority in priorities {
                usable_candidate_indices.clear();
                usable_candidate_indices.extend(group.candidates.iter().enumerate().filter_map(
                    |(index, candidate)| {
                        let route = &routes[candidate.route_index];
                        (priority == 3 || route.priority == priority)
                            .then_some(index)
                            .filter(|&index| {
                                let route = &routes[group.candidates[index].route_index];
                                group.candidates[index].allowance > 0.0
                                    && target_free[route.target_slot()] > 0.0
                            })
                    },
                ));
                if usable_candidate_indices.is_empty() || available <= 0.0 {
                    continue;
                }
                if usable_candidate_indices.len() == 1 {
                    let index = usable_candidate_indices[0];
                    let candidate = &mut group.candidates[index];
                    let route = &routes[candidate.route_index];
                    let target_slot = route.target_slot();
                    let free = target_free[target_slot];
                    let requested = available
                        .min(candidate.allowance)
                        .min(free)
                        .floor()
                        .max(0.0);
                    if requested > 0.0 {
                        let moved = move_to_target(
                            state,
                            base,
                            entities,
                            quantum_bandwidth,
                            &mut quantum_session,
                            route,
                            item_id,
                            requested,
                        )?;
                        if moved <= 0.0 {
                            continue;
                        }
                        record_material_movement(
                            changed_entity_indices,
                            expand_compact_index(prepared_group.source_index),
                            route.target_index(),
                            moved,
                        );
                        target_free[target_slot] -= moved;
                        queue_target_source_wakes(
                            state,
                            entities,
                            prepared_routes,
                            route,
                            prepared_group.item_symbol,
                            pending_wake_group_indices,
                        )?;
                        candidate.allowance -= moved;
                        candidate.moved += moved;
                        available -= moved;
                        set_number(
                            entities[expand_compact_index(prepared_group.source_index)]
                                .as_object_mut()
                                .ok_or_else(|| anyhow!("native belt source is not an object"))?,
                            "routingCursor",
                            0.0,
                        )?;
                    }
                    continue;
                }
                let source_cursor = finite_number(
                    entities[expand_compact_index(prepared_group.source_index)]
                        .as_object()
                        .and_then(|source| source.get("routingCursor")),
                )
                .floor()
                .max(0.0) as usize;
                let mut cursor = source_cursor % usable_candidate_indices.len();
                while available > 0.0 {
                    active_candidate_indices.clear();
                    active_candidate_indices.extend(
                        usable_candidate_indices.iter().copied().filter(|&index| {
                            let route = &routes[group.candidates[index].route_index];
                            group.candidates[index].allowance > 0.0
                                && target_free[route.target_slot()] > 0.0
                        }),
                    );
                    if active_candidate_indices.is_empty() {
                        break;
                    }
                    let start = cursor % active_candidate_indices.len();
                    let fair_share = (available / active_candidate_indices.len() as f64)
                        .floor()
                        .max(1.0);
                    let mut successful = 0;
                    for offset in 0..active_candidate_indices.len() {
                        if available <= 0.0 {
                            break;
                        }
                        let index = active_candidate_indices
                            [(start + offset) % active_candidate_indices.len()];
                        let candidate = &mut group.candidates[index];
                        let route = &routes[candidate.route_index];
                        let target_slot = route.target_slot();
                        let free = target_free[target_slot];
                        let requested = available
                            .min(fair_share)
                            .min(candidate.allowance)
                            .min(free)
                            .floor()
                            .max(0.0);
                        if requested <= 0.0 {
                            continue;
                        }
                        let moved = move_to_target(
                            state,
                            base,
                            entities,
                            quantum_bandwidth,
                            &mut quantum_session,
                            route,
                            item_id,
                            requested,
                        )?;
                        if moved <= 0.0 {
                            continue;
                        }
                        record_material_movement(
                            changed_entity_indices,
                            expand_compact_index(prepared_group.source_index),
                            route.target_index(),
                            moved,
                        );
                        target_free[target_slot] -= moved;
                        queue_target_source_wakes(
                            state,
                            entities,
                            prepared_routes,
                            route,
                            prepared_group.item_symbol,
                            pending_wake_group_indices,
                        )?;
                        candidate.allowance -= moved;
                        candidate.moved += moved;
                        available -= moved;
                        successful += 1;
                        cursor = (cursor + 1) % usable_candidate_indices.len();
                    }
                    if successful == 0 {
                        break;
                    }
                }
                set_number(
                    entities[expand_compact_index(prepared_group.source_index)]
                        .as_object_mut()
                        .ok_or_else(|| anyhow!("native belt source is not an object"))?,
                    "routingCursor",
                    cursor as f64,
                )?;
                if available <= 0.0 {
                    break;
                }
            }

            // The JS active-route queue does not materialize a missing output key
            // when a completely idle source has no cargo. Preserve that sparse
            // object shape; once a key existed (including a positive source that
            // was drained to zero), it must still be written back.
            if group.source_had_output || group.available > 0.0 {
                set_output(
                    entities[expand_compact_index(prepared_group.source_index)]
                        .as_object_mut()
                        .ok_or_else(|| anyhow!("native belt source is not an object"))?,
                    item_id,
                    available,
                )?;
            }
            for candidate in &group.candidates {
                let route = &routes[candidate.route_index];
                let free = target_free[route.target_slot()];
                post_actions[candidate.route_index] = BeltPostAction::Flow {
                    available,
                    free,
                    moved: candidate.moved,
                };
            }
            for route_index in group
                .first_inactive_route
                .iter()
                .copied()
                .chain(group.inactive_routes.iter().copied())
            {
                let route = &routes[route_index];
                let free = target_free[route.target_slot()];
                post_actions[route_index] = BeltPostAction::Flow {
                    available,
                    free,
                    moved: 0.0,
                };
            }
        }
        profiler.mark("belt-transfer-stable-apply");
        pending_wake_group_indices.sort_unstable();
        pending_wake_group_indices.dedup();
        let mut pending_wakes = std::mem::take(pending_wake_group_indices);
        let finalize_result = (|| -> anyhow::Result<()> {
            apply_belt_post_actions(
                belt_runtime,
                prepared_routes,
                selection,
                seconds,
                defer_source_depletion_reset,
                flow_window_seconds,
            )?;
            // The captured selection predates this phase's actual input movement.
            // A dormant ordinary producer may therefore become eligible only
            // after one of its inputs arrives. Full-scan semantics already
            // advanced every one of its output routes at the start of the phase;
            // catch up only groups absent from that immutable selection, then let
            // reservation grant same-step output credit. Zero-second output
            // phases only carry the wake into the next exact step.
            catch_up_newly_woken_ordinary_producer_clocks(
                belt_runtime,
                state,
                entities,
                prepared_routes,
                selection,
                &pending_wakes,
                seconds,
                belt_limit,
            )?;
            crate::quantum_logistics::finish_supply_deposit_session(base, quantum_session)?;
            refresh_active_groups(belt_runtime, state, entities, prepared_routes, selection)?;
            for group_index in pending_wakes.iter().copied() {
                belt_runtime.wake_group(group_index)?;
            }
            Ok(())
        })();
        pending_wakes.clear();
        belt_runtime.workspace.pending_wake_group_indices = pending_wakes;
        finalize_result?;
        // Each successful route contributes at most two indices, so temporary
        // evidence is bounded by twice the prepared route count. Canonicalizing
        // here gives downstream wake caches stable topology order and excludes
        // probes that did not actually move material.
        finalize_material_movement_evidence(changed_entity_indices);
        profiler.mark("belt-transfer-finalize");
        Ok(())
    })
}

pub(crate) fn reserve(
    state: &CoreState,
    base: &Map<String, Value>,
    entities: &[Value],
    belt_runtime: &mut BeltRuntime,
    prepared_routes: &PreparedRoutes,
) -> anyhow::Result<BeltStepReservation> {
    let routes = &prepared_routes.routes;
    let belt_limit = normalized_buffer_limit(
        base.get("settings")
            .and_then(Value::as_object)
            .and_then(|settings| settings.get("beltBufferLimit")),
    );
    let mut profiler = BeltTransferProfiler::new();
    let mut quantum_session = None;
    with_active_selection(belt_runtime, prepared_routes, |belt_runtime, selection| {
        let mut result = BeltStepReservation {
            allowance_by_belt: HashMap::new(),
            output_credits: OutputCredits {
                group_by_key: Arc::clone(&prepared_routes.group_by_key),
                by_group: HashMap::new(),
                active_source_items: Vec::new(),
            },
        };
        belt_runtime.record_selection(prepared_routes, selection, true);
        let progress = &belt_runtime.progress;
        let target_free = &mut belt_runtime.workspace.target_free;
        let touched_target_slots = &mut belt_runtime.workspace.touched_target_slots;
        let target_capacity_diagnostics = prepare_reservation_target_capacities_with_runtime(
            state,
            base,
            entities,
            prepared_routes,
            selection,
            progress,
            target_free,
            touched_target_slots,
            &mut quantum_session,
            deterministic_runtime(),
        )?;
        profiler.mark("belt-reservation-target-capacity-plan");
        profiler.reservation_target_capacity_plan(target_capacity_diagnostics);

        for belt_index in selection.route_indices(routes.len()) {
            let route = &routes[belt_index];
            let source_group = route.source_group();
            let allowance = (progress[belt_index] + EPSILON).floor().max(0.0);
            if allowance < 1.0 {
                continue;
            }
            let _target = entities[route.target_index()]
                .as_object()
                .ok_or_else(|| anyhow!("native belt target is not an object"))?;
            let prepared_group = &prepared_routes.groups[source_group];
            let _item_id = state
                .symbols
                .resolve(prepared_group.item_symbol)
                .ok_or_else(|| anyhow!("native prepared belt item is missing"))?;
            let target_slot = route.target_slot();
            if !target_free[target_slot].is_finite() {
                bail!("native belt reservation target-capacity plan is incomplete");
            }
            let free = target_free[target_slot];
            let reserved = allowance.min(free.floor().max(0.0));
            if reserved < 1.0 {
                continue;
            }
            result.allowance_by_belt.insert(
                compact_index(belt_index, "reservation route index")?,
                reserved,
            );
            target_free[target_slot] -= reserved;
            let source_group = route.source_group;
            let credit = result
                .output_credits
                .by_group
                .entry(source_group)
                .or_insert(0.0);
            *credit = (*credit + reserved).min(belt_limit);
        }
        profiler.mark("belt-reservation-stable-apply");
        belt_runtime.diagnostics.reservation_allowance_entries = result.allowance_by_belt.len();
        let mut credited_group_indices = result
            .output_credits
            .by_group
            .iter()
            .filter_map(|(&group_index, &credit)| (credit > EPSILON).then_some(group_index))
            .collect::<Vec<_>>();
        credited_group_indices.sort_unstable();
        result.output_credits.active_source_items = credited_group_indices
            .into_iter()
            .filter_map(|group_index| prepared_routes.groups.get(group_index as usize))
            .map(|group| (group.source_index, group.item_symbol))
            .collect();
        belt_runtime.diagnostics.reservation_credit_entries = result.output_credits.by_group.len();
        Ok(result)
    })
}

pub(crate) fn output_credit(
    state: &CoreState,
    credits: &OutputCredits,
    entity_id: &str,
    item_id: &str,
) -> f64 {
    let Some(entity_index) = state.entity_index.get(entity_id).copied() else {
        return 0.0;
    };
    let Some(item_symbol) = state.symbols.lookup(item_id) else {
        return 0.0;
    };
    credits.get(entity_index, item_symbol)
}

pub(crate) fn aggregate_flow_from_state(state: &CoreState) -> anyhow::Result<BeltFlowAggregate> {
    let mut capacity = 0.0;
    let mut flow = 0.0;
    for index in 0..state.belts.ids.len() {
        let belt = state.parse_belt(index)?;
        let belt = belt
            .as_object()
            .ok_or_else(|| anyhow!("native belt record is not an object"))?;
        let tier = belt
            .get("tier")
            .and_then(Value::as_u64)
            .and_then(|value| u8::try_from(value).ok())
            .ok_or_else(|| anyhow!("native belt tier is missing"))?;
        let speed = state
            .catalog
            .belt_speeds
            .get(&tier)
            .copied()
            .with_context(|| format!("native belt tier {tier} is missing"))?;
        let (lanes, stack_size) = persisted_belt_dimensions(belt);
        capacity += speed * lanes * stack_size;
        flow += finite_number(belt.get("lastFlow")).max(0.0);
    }
    if !capacity.is_finite() || !flow.is_finite() {
        bail!("native belt aggregate is non-finite");
    }
    Ok(BeltFlowAggregate { capacity, flow })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn builtin_ordinary_machine_state(input_amount: f64) -> (CoreState, Value) {
        let entity = json!({
            "id": "ordinary-epsilon-machine",
            "kind": "machine",
            "planetId": "home",
            "powerGridId": "grid-a",
            "buildingId": "arc_smelter",
            "recipeId": "iron_ingot",
            "machineCount": 1,
            "minerCount": 0,
            "inputs": { "iron_ore": input_amount },
            "outputs": { "iron_ingot": 0 },
            "progress": 0,
            "utilization": 0,
            "productionRate": 0,
            "routingCursor": 0,
            "proliferatorBonusProgress": { "iron_ingot": 0 }
        });
        let mut state = crate::simple_factory::tests::fixture_state(std::slice::from_ref(&entity));
        state.identity.registry_fingerprint = EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT.to_owned();
        let catalog = Arc::make_mut(&mut state.catalog);
        catalog.snapshot.registry_fingerprint = EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT.to_owned();
        catalog
            .recipes
            .get_mut("iron_ingot")
            .expect("fixture iron recipe")
            .inputs[0]
            .amount = 2.0;
        (state, entity)
    }

    #[test]
    fn ordinary_producer_complete_input_seed_matches_settlement_cycle_floor() {
        for (amount, expected) in [(1.9997, false), (1.9998, true), (1.9999, true), (2.0, true)] {
            let (state, entity) = builtin_ordinary_machine_state(amount);
            let source = entity.as_object().unwrap();
            assert_eq!(
                ordinary_machine_has_complete_input_cycle(&state, source, "iron_ingot"),
                expected,
                "input={amount}"
            );
            assert!(
                !source_may_produce_during_step(&state, source, "iron_ingot"),
                "built-in ordinary output must use the closed reverse wake"
            );
        }
    }

    #[test]
    fn ordinary_producer_mod_registry_fails_closed_to_always_awake() {
        let (mut state, entity) = builtin_ordinary_machine_state(0.0);
        state.identity.registry_fingerprint = "mod:opaque-v1".to_owned();
        let source = entity.as_object().unwrap();
        assert!(!ordinary_machine_has_complete_input_cycle(
            &state,
            source,
            "iron_ingot"
        ));
        assert!(source_may_produce_during_step(&state, source, "iron_ingot"));
    }

    #[test]
    fn ordinary_producer_global_barrier_recipes_remain_always_awake() {
        for recipe_id in [
            "matrix_research",
            "solar_sail_launch",
            "carrier_rocket_launch",
        ] {
            let (mut state, mut entity) = builtin_ordinary_machine_state(0.0);
            Arc::make_mut(&mut state.catalog)
                .recipes
                .get_mut(recipe_id)
                .unwrap()
                .outputs
                .push(crate::catalog::ItemAmount {
                    item_id: "iron_ingot".to_owned(),
                    amount: 1.0,
                });
            entity
                .as_object_mut()
                .unwrap()
                .insert("recipeId".to_owned(), Value::from(recipe_id));
            let source = entity.as_object().unwrap();
            assert!(!ordinary_machine_has_complete_input_cycle(
                &state,
                source,
                "iron_ingot"
            ));
            assert!(
                source_may_produce_during_step(&state, source, "iron_ingot"),
                "global barrier {recipe_id} must fail closed"
            );
        }
    }

    #[test]
    fn ordinary_producer_wake_skips_an_unrouted_uninterned_sibling_output() {
        let (mut state, entity) = builtin_ordinary_machine_state(0.0);
        Arc::make_mut(&mut state.catalog)
            .recipes
            .get_mut("iron_ingot")
            .unwrap()
            .outputs
            .push(crate::catalog::ItemAmount {
                item_id: "unrouted_co_product".to_owned(),
                amount: 1.0,
            });
        assert!(state.symbols.lookup("unrouted_co_product").is_none());
        let output_symbol = state.symbols.lookup("iron_ingot").unwrap();
        let prepared = PreparedRoutes {
            routes: Vec::new(),
            groups: Vec::new(),
            target_slot_count: 0,
            total_capacity: 0.0,
            group_by_key: Arc::new(HashMap::from([((0, output_symbol), 7)])),
        };
        let route = Route {
            capacity: 6.0,
            source_index: 0,
            target_index: 0,
            source_group: 0,
            target_slot: 0,
            belt_sort_rank: 0,
            target_port_index: None,
            priority: 1,
        };
        let mut pending = Vec::new();
        queue_target_source_wakes(
            &state,
            std::slice::from_ref(&entity),
            &prepared,
            &route,
            u32::MAX,
            &mut pending,
        )
        .unwrap();
        assert_eq!(pending, vec![7]);
    }

    #[test]
    fn material_movement_evidence_requires_real_flow_and_is_sorted_deduplicated() {
        let mut changed = Vec::new();
        record_material_movement(&mut changed, 9, 3, 0.0);
        record_material_movement(&mut changed, 8, 2, -1.0);
        assert!(
            changed.is_empty(),
            "queries and blocked routes are not wake evidence"
        );

        record_material_movement(&mut changed, 9, 3, 4.0);
        record_material_movement(&mut changed, 3, 7, 2.0);
        record_material_movement(&mut changed, 9, 3, 1.0);
        finalize_material_movement_evidence(&mut changed);
        assert_eq!(changed, vec![3, 7, 9]);
    }

    fn materialize_rewrite(raw: &str, patch: BeltDynamicRawPatch) -> String {
        rewrite_belt_dynamic_raw(raw, patch)
            .unwrap()
            .unwrap_or_else(|| raw.to_owned())
    }

    fn legacy_dynamic_patch(raw: &str, patch: BeltDynamicRawPatch) -> Value {
        let mut value: Value = serde_json::from_str(raw).unwrap();
        let object = value.as_object_mut().unwrap();
        if let Some(value) = patch.progress {
            set_number(object, "progress", value).unwrap();
        }
        if let Some(value) = patch.last_flow {
            set_number(object, "lastFlow", value).unwrap();
        }
        if let Some(value) = patch.congestion {
            set_number(object, "congestion", value).unwrap();
        }
        if let Some(value) = patch.total_transferred {
            set_number(object, "totalTransferred", value).unwrap();
        }
        value
    }

    fn xorshift64(state: &mut u64) -> u64 {
        *state ^= *state << 13;
        *state ^= *state >> 7;
        *state ^= *state << 17;
        *state
    }

    fn kernel_prepared_routes(route_count: usize) -> PreparedRoutes {
        let routes = (0..route_count)
            .map(|index| Route {
                capacity: (index % 13 + 1) as f64 * 1.125,
                source_index: 0,
                target_index: 0,
                source_group: 0,
                target_slot: 0,
                belt_sort_rank: compact_index(index, "kernel belt rank").unwrap(),
                target_port_index: None,
                priority: 1,
            })
            .collect::<Vec<_>>();
        PreparedRoutes {
            total_capacity: routes.iter().map(|route| route.capacity).sum(),
            routes,
            groups: Vec::new(),
            target_slot_count: 0,
            group_by_key: Arc::new(HashMap::new()),
        }
    }

    fn kernel_runtime(route_count: usize) -> BeltRuntime {
        BeltRuntime {
            reusable_pool: None,
            source: None,
            progress: (0..route_count)
                .map(|index| index as f64 * 0.03125 - 2.0)
                .collect(),
            total_transferred: (0..route_count)
                .map(|index| (index % 97) as f64 * 3.0)
                .collect(),
            congestion: (0..route_count)
                .map(|index| (index % 101) as f64 / 100.0)
                .collect(),
            last_flow: (0..route_count)
                .map(|index| (index % 67) as f64 * 0.125)
                .collect(),
            total_dirty: BeltPagedColumn::with_len_default(route_count),
            touched_routes: TouchedRoutes::default(),
            belt_capacity: 0.0,
            active_groups: Vec::new(),
            active_group_indices: Vec::new(),
            active_queue_enabled: false,
            diagnostics: BeltSchedulerDiagnostics::default(),
            workspace: BeltWorkspace::new(route_count, 0, 0),
        }
    }

    #[test]
    fn ordinary_producer_catchup_advances_only_groups_absent_from_captured_selection() {
        let (_, first) = builtin_ordinary_machine_state(0.0);
        let mut second = first.clone();
        second.as_object_mut().unwrap().insert(
            "id".to_owned(),
            Value::from("ordinary-epsilon-machine-second"),
        );
        let entities = vec![first, second];
        let mut state = crate::simple_factory::tests::fixture_state(&entities);
        state.identity.registry_fingerprint = EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT.to_owned();
        Arc::make_mut(&mut state.catalog)
            .snapshot
            .registry_fingerprint = EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT.to_owned();
        let item_symbol = state.symbols.lookup("iron_ingot").unwrap();
        let route = |index: usize| Route {
            capacity: 6.0,
            source_index: compact_index(index, "ordinary catch-up source").unwrap(),
            target_index: compact_index(index, "ordinary catch-up target").unwrap(),
            source_group: compact_index(index, "ordinary catch-up group").unwrap(),
            target_slot: compact_index(index, "ordinary catch-up slot").unwrap(),
            belt_sort_rank: 0,
            target_port_index: None,
            priority: 1,
        };
        let prepared = PreparedRoutes {
            routes: vec![route(0), route(1)],
            groups: (0..2)
                .map(|index| PreparedGroup {
                    source_index: compact_index(index, "ordinary catch-up source").unwrap(),
                    item_symbol,
                    balanced_splitter: false,
                    always_awake: false,
                    route_indices: vec![compact_index(index, "ordinary catch-up route").unwrap()]
                        .into_boxed_slice(),
                })
                .collect(),
            target_slot_count: 2,
            total_capacity: 12.0,
            group_by_key: Arc::new(HashMap::from([
                ((0, item_symbol), 0),
                ((1, item_symbol), 1),
            ])),
        };
        let mut runtime = kernel_runtime(2);
        // Group 0 models the clock already applied by the captured selection;
        // group 1 is the newly reverse-woken producer output.
        runtime.progress[0] = 6.0;
        runtime.progress[1] = 0.0;
        catch_up_newly_woken_ordinary_producer_clocks(
            &mut runtime,
            &state,
            &entities,
            &prepared,
            &ActiveSelection::Mask {
                selected_group_indices: vec![0],
                selected_route_indices: vec![0],
            },
            &[0, 1],
            1.0,
            100.0,
        )
        .unwrap();
        assert_eq!(runtime.progress[0].to_bits(), 6.0_f64.to_bits());
        assert_eq!(runtime.progress[1].to_bits(), 6.0_f64.to_bits());
        assert_eq!(runtime.touched_routes.signature(), Some(vec![1]));
    }

    #[test]
    fn touched_routes_seal_sorts_deduplicates_and_crosses_255_256_as_u32() {
        let mut touched = TouchedRoutes::default();
        for index in [256_usize, 1, 255, 256, 0, 255] {
            touched.record_index(index).unwrap();
        }
        let evidence = touched.seal(300).unwrap().unseal().unwrap();
        match evidence {
            TouchedRouteEvidence::Sparse(indices) => {
                assert_eq!(&*indices, &[0, 1, 255, 256]);
            }
            TouchedRouteEvidence::All => panic!("sparse evidence unexpectedly became all"),
        }
    }

    #[test]
    fn touched_routes_noop_and_existing_dense_selection_are_explicit() {
        let evidence = TouchedRoutes::default()
            .seal(300)
            .unwrap()
            .unseal()
            .unwrap();
        assert!(matches!(
            evidence,
            TouchedRouteEvidence::Sparse(indices) if indices.is_empty()
        ));

        let mut touched = TouchedRoutes::default();
        touched.record_selection(
            &empty_prepared_routes(),
            &ActiveSelection::Dense {
                selected_group_indices: vec![0],
                selected_route_indices: vec![255, 256],
            },
        );
        assert!(matches!(
            touched.seal(300).unwrap().unseal().unwrap(),
            TouchedRouteEvidence::All
        ));
    }

    #[test]
    fn touched_routes_seal_rejects_out_of_range_and_forged_evidence_atomically() {
        let mut outside = TouchedRoutes::default();
        outside.record_index(300).unwrap();
        assert!(outside.seal(300).is_err());

        let mut touched = TouchedRoutes::default();
        touched.record_index(255).unwrap();
        let mut sealed = touched.seal(300).unwrap();
        sealed.forge_evidence_for_test(TouchedRouteEvidence::Sparse(vec![256].into_boxed_slice()));
        assert!(sealed.unseal().is_err());
    }

    type BeltKernelSignature = (
        Vec<u64>,
        Vec<u64>,
        Vec<u64>,
        Vec<u64>,
        Vec<bool>,
        Option<Vec<u32>>,
    );

    fn runtime_kernel_signature(runtime: &BeltRuntime) -> BeltKernelSignature {
        (
            runtime
                .progress
                .iter()
                .map(|value| value.to_bits())
                .collect(),
            runtime
                .total_transferred
                .iter()
                .map(|value| value.to_bits())
                .collect(),
            runtime
                .congestion
                .iter()
                .map(|value| value.to_bits())
                .collect(),
            runtime
                .last_flow
                .iter()
                .map(|value| value.to_bits())
                .collect(),
            runtime.total_dirty.iter().copied().collect(),
            runtime.touched_routes.signature(),
        )
    }

    const SOURCE_SNAPSHOT_ITEMS: [&str; 2] = ["mod:扩展/单极磁石", "emoji/🚀"];

    fn source_snapshot_item(symbol: u32) -> Option<&'static str> {
        SOURCE_SNAPSHOT_ITEMS.get(symbol as usize).copied()
    }

    fn source_snapshot_fixture(group_count: usize) -> (Vec<Value>, PreparedRoutes) {
        let mut entities = Vec::with_capacity(group_count);
        let mut groups = Vec::with_capacity(group_count);
        for group_index in 0..group_count {
            let item_symbol = u32::try_from(group_index % SOURCE_SNAPSHOT_ITEMS.len()).unwrap();
            let item_id = source_snapshot_item(item_symbol).unwrap();
            let mut outputs = Map::new();
            match group_index % 5 {
                0 => {
                    outputs.insert(item_id.to_owned(), Value::from(group_index as f64 + 10.75));
                }
                1 => {
                    outputs.insert("mod:无关/保留".to_owned(), Value::from(group_index));
                }
                2 => {
                    outputs.insert(item_id.to_owned(), Value::Null);
                }
                3 => {
                    outputs.insert(item_id.to_owned(), Value::from("MOD-invalid-number"));
                }
                _ => {
                    outputs.insert(item_id.to_owned(), Value::from(-0.0));
                }
            }
            entities.push(json!({
                "id": format!("MOD/源-{group_index}-中"),
                "outputs": outputs,
                "modPayload": { "unicode": "量子🚀" }
            }));
            groups.push(PreparedGroup {
                source_index: compact_index(group_index, "source snapshot entity index").unwrap(),
                item_symbol,
                balanced_splitter: false,
                always_awake: false,
                route_indices: Box::default(),
            });
        }
        (
            entities,
            PreparedRoutes {
                routes: Vec::new(),
                groups,
                target_slot_count: 0,
                total_capacity: 0.0,
                group_by_key: Arc::new(HashMap::new()),
            },
        )
    }

    type SourceSnapshotSignature = Vec<(u64, bool, bool, usize, bool, usize)>;

    fn seeded_source_snapshot_groups(group_count: usize) -> Vec<Group> {
        (0..group_count)
            .map(|group_index| Group {
                available: -(group_index as f64 + 1.0),
                source_had_output: false,
                first_candidate: Some(Candidate {
                    route_index: group_index,
                    allowance: 3.0,
                    moved: 1.0,
                }),
                candidates: vec![Candidate {
                    route_index: group_index,
                    allowance: 5.0,
                    moved: 2.0,
                }],
                first_inactive_route: Some(group_index),
                inactive_routes: vec![group_index],
            })
            .collect()
    }

    fn source_snapshot_signature(groups: &[Group]) -> SourceSnapshotSignature {
        groups
            .iter()
            .map(|group| {
                (
                    group.available.to_bits(),
                    group.source_had_output,
                    group.first_candidate.is_some(),
                    group.candidates.len(),
                    group.first_inactive_route.is_some(),
                    group.inactive_routes.len(),
                )
            })
            .collect()
    }

    #[test]
    fn dense_source_snapshots_match_serial_bitwise_at_one_two_four_and_eight_workers() {
        let group_count = crate::deterministic_runtime::PARALLEL_MIN_ITEMS + 257;
        let (entities, prepared) = source_snapshot_fixture(group_count);
        let run = |workers| {
            let selection = ActiveSelection::Dense {
                // Dense mode deliberately ignores and merely recycles this
                // wake scratch; the probe order must remain the full flat row order.
                selected_group_indices: vec![9, 3, 1],
                selected_route_indices: Vec::new(),
            };
            let mut groups = seeded_source_snapshot_groups(group_count);
            reset_belt_source_snapshots_with_runtime(
                &entities,
                &prepared,
                &selection,
                &mut groups,
                &DeterministicRuntime::for_test(workers),
                source_snapshot_item,
            )
            .unwrap();
            source_snapshot_signature(&groups)
        };

        let expected = run(1);
        for workers in [2, 4, 8] {
            assert_eq!(run(workers), expected, "workers={workers}");
        }
        assert_eq!(expected[0].0, 10.0_f64.to_bits());
        assert!(expected[0].1);
        assert_eq!(expected[1].0, 0.0_f64.to_bits());
        assert!(!expected[1].1);
        assert_eq!(expected[2].0, 0.0_f64.to_bits());
        assert!(
            expected[2].1,
            "present invalid values retain output-key evidence"
        );
        assert!(
            expected
                .iter()
                .all(|row| !row.2 && row.3 == 0 && !row.4 && row.5 == 0)
        );
    }

    #[test]
    fn sparse_source_snapshots_match_serial_and_leave_sleeping_groups_untouched() {
        let selected_count = crate::deterministic_runtime::PARALLEL_MIN_ITEMS + 37;
        let group_count = selected_count * 2 + 1;
        let (entities, prepared) = source_snapshot_fixture(group_count);
        let selected_group_indices = (0..selected_count)
            .map(|index| compact_index(index * 2, "sparse source snapshot group").unwrap())
            .collect::<Vec<_>>();
        let run = |workers| {
            let selection = ActiveSelection::Mask {
                selected_group_indices: selected_group_indices.clone(),
                selected_route_indices: Vec::new(),
            };
            let mut groups = seeded_source_snapshot_groups(group_count);
            reset_belt_source_snapshots_with_runtime(
                &entities,
                &prepared,
                &selection,
                &mut groups,
                &DeterministicRuntime::for_test(workers),
                source_snapshot_item,
            )
            .unwrap();
            source_snapshot_signature(&groups)
        };

        let expected = run(1);
        for workers in [2, 4, 8] {
            assert_eq!(run(workers), expected, "workers={workers}");
        }
        assert_eq!(expected[0].0, 10.0_f64.to_bits());
        assert_eq!(expected[1].0, (-2.0_f64).to_bits());
        assert!(
            expected[1].2 && expected[1].4,
            "sleeping group was not reset"
        );
        assert_eq!(
            expected[group_count - 1].0,
            (-(group_count as f64)).to_bits()
        );
    }

    #[test]
    fn source_snapshot_missing_symbol_keeps_first_error_and_serial_mutation_boundary() {
        let group_count = crate::deterministic_runtime::PARALLEL_MIN_ITEMS + 64;
        let first_missing = 17;
        let second_missing = crate::deterministic_runtime::PARALLEL_MIN_ITEMS + 5;
        let (entities, mut prepared) = source_snapshot_fixture(group_count);
        prepared.groups[first_missing].item_symbol = 77;
        prepared.groups[second_missing].item_symbol = 88;
        let run = |workers| {
            let mut groups = seeded_source_snapshot_groups(group_count);
            let error = reset_belt_source_snapshots_with_runtime(
                &entities,
                &prepared,
                &ActiveSelection::All,
                &mut groups,
                &DeterministicRuntime::for_test(workers),
                source_snapshot_item,
            )
            .unwrap_err()
            .to_string();
            (error, source_snapshot_signature(&groups))
        };

        let expected = run(1);
        for workers in [2, 4, 8] {
            assert_eq!(run(workers), expected, "workers={workers}");
        }
        assert_eq!(expected.0, "native prepared belt item is missing");
        assert!(!expected.1[first_missing - 1].2);
        assert!(
            expected.1[first_missing].2,
            "the first invalid symbol must stop stable replay before that group"
        );
        assert!(expected.1[first_missing + 1].2);
    }

    #[test]
    fn dense_belt_clock_kernel_matches_serial_bitwise_at_one_two_four_and_eight_workers() {
        let route_count = crate::deterministic_runtime::PARALLEL_MIN_ITEMS + 257;
        let prepared = kernel_prepared_routes(route_count);
        let run = |workers| {
            let mut runtime = kernel_runtime(route_count);
            advance_belt_clocks_with_runtime(
                &mut runtime,
                &prepared,
                &ActiveSelection::All,
                1.375,
                9_007_199_254_740_991.0,
                &DeterministicRuntime::for_test(workers),
            )
            .unwrap();
            runtime_kernel_signature(&runtime)
        };
        let expected = run(1);
        for workers in [2, 4, 8] {
            assert_eq!(run(workers), expected, "worker limit {workers}");
        }
    }

    #[test]
    fn dense_belt_post_action_kernel_matches_serial_bitwise_at_one_two_four_and_eight_workers() {
        let route_count = crate::deterministic_runtime::PARALLEL_MIN_ITEMS + 257;
        let prepared = kernel_prepared_routes(route_count);
        for (seconds, defer_reset, flow_window) in [
            (0.0, false, 0.0),
            (0.0, true, 1.0),
            (1.0, false, 1.0),
            (5.0, true, 5.0),
        ] {
            let run = |workers| {
                let mut runtime = kernel_runtime(route_count);
                for (index, action) in runtime.workspace.post_actions.iter_mut().enumerate() {
                    *action = match index % 5 {
                        0 => BeltPostAction::None,
                        1 => BeltPostAction::ResetProgress,
                        2 => BeltPostAction::Flow {
                            available: 0.0,
                            free: 7.0,
                            moved: 0.0,
                        },
                        3 => BeltPostAction::Flow {
                            available: 11.0,
                            free: 0.0,
                            moved: 0.0,
                        },
                        _ => BeltPostAction::Flow {
                            available: 19.0,
                            free: 23.0,
                            moved: (index % 7 + 1) as f64,
                        },
                    };
                }
                apply_belt_post_actions_with_runtime(
                    &mut runtime,
                    &prepared,
                    &ActiveSelection::All,
                    seconds,
                    defer_reset,
                    flow_window,
                    &DeterministicRuntime::for_test(workers),
                )
                .unwrap();
                runtime_kernel_signature(&runtime)
            };
            let expected = run(1);
            for workers in [2, 4, 8] {
                assert_eq!(
                    run(workers),
                    expected,
                    "workers={workers}, seconds={seconds}, defer={defer_reset}, window={flow_window}"
                );
            }
        }
    }

    #[test]
    fn sparse_touched_evidence_covers_clock_reset_and_total_at_one_two_four_and_eight_workers() {
        let route = |source_group: usize, belt_sort_rank: usize| Route {
            capacity: 6.0,
            source_index: compact_index(source_group, "test source index").unwrap(),
            target_index: 0,
            source_group: compact_index(source_group, "test source group").unwrap(),
            target_slot: 0,
            belt_sort_rank: compact_index(belt_sort_rank, "test belt rank").unwrap(),
            target_port_index: None,
            priority: 1,
        };
        let prepared = PreparedRoutes {
            routes: vec![route(0, 0), route(1, 0), route(1, 1), route(0, 1)],
            groups: vec![
                PreparedGroup {
                    source_index: 0,
                    item_symbol: 0,
                    balanced_splitter: false,
                    always_awake: false,
                    route_indices: vec![0, 3].into_boxed_slice(),
                },
                PreparedGroup {
                    source_index: 1,
                    item_symbol: 0,
                    balanced_splitter: false,
                    always_awake: false,
                    route_indices: vec![1, 2].into_boxed_slice(),
                },
            ],
            target_slot_count: 1,
            total_capacity: 24.0,
            group_by_key: Arc::new(HashMap::new()),
        };
        let run = |workers| {
            let mut runtime = kernel_runtime(4);
            let untouched_before = (
                runtime.progress[0].to_bits(),
                runtime.progress[3].to_bits(),
                runtime.total_transferred[0].to_bits(),
                runtime.total_transferred[3].to_bits(),
            );
            let selection = ActiveSelection::Mask {
                selected_group_indices: vec![1],
                selected_route_indices: vec![1, 2],
            };
            let executor = DeterministicRuntime::for_test(workers);
            advance_belt_clocks_with_runtime(
                &mut runtime,
                &prepared,
                &selection,
                1.0,
                100.0,
                &executor,
            )
            .unwrap();
            runtime.workspace.post_actions[1] = BeltPostAction::ResetProgress;
            runtime.workspace.post_actions[2] = BeltPostAction::Flow {
                available: 10.0,
                free: 10.0,
                moved: 2.0,
            };
            apply_belt_post_actions_with_runtime(
                &mut runtime,
                &prepared,
                &selection,
                1.0,
                false,
                1.0,
                &executor,
            )
            .unwrap();
            assert_eq!(runtime.progress[1].to_bits(), 0.0_f64.to_bits());
            assert!(runtime.total_dirty[2]);
            assert_eq!(
                (
                    runtime.progress[0].to_bits(),
                    runtime.progress[3].to_bits(),
                    runtime.total_transferred[0].to_bits(),
                    runtime.total_transferred[3].to_bits(),
                ),
                untouched_before
            );
            assert_eq!(runtime.touched_routes.signature(), Some(vec![1, 2]));
            runtime_kernel_signature(&runtime)
        };
        let expected = run(1);
        for workers in [2, 4, 8] {
            assert_eq!(run(workers), expected, "workers={workers}");
        }
    }

    fn legacy_set_output(
        entity: &mut Map<String, Value>,
        item_id: &str,
        amount: f64,
    ) -> anyhow::Result<()> {
        let outputs = entity
            .get_mut("outputs")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native belt source outputs are missing"))?;
        outputs.insert(
            item_id.to_owned(),
            Number::from_f64(amount)
                .map(Value::Number)
                .ok_or_else(|| anyhow!("native belt output is non-finite"))?,
        );
        Ok(())
    }

    fn legacy_add_input(
        entity: &mut Map<String, Value>,
        item_id: &str,
        amount: f64,
    ) -> anyhow::Result<()> {
        let inputs = entity
            .get_mut("inputs")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native belt target inputs are missing"))?;
        let current = inputs
            .get(item_id)
            .map(|value| finite_number(Some(value)))
            .unwrap_or(0.0);
        inputs.insert(
            item_id.to_owned(),
            Number::from_f64((current + amount).floor())
                .map(Value::Number)
                .ok_or_else(|| anyhow!("native belt input is non-finite"))?,
        );
        Ok(())
    }

    fn item_key_pointer(items: &Map<String, Value>, item_id: &str) -> usize {
        items
            .keys()
            .find(|key| key.as_str() == item_id)
            .expect("test item key exists")
            .as_ptr() as usize
    }

    #[test]
    fn existing_transfer_item_keys_are_overwritten_in_place() {
        let item_id = "mod:扩展/单极磁石";
        let mut entity = json!({
            "outputs": {
                "alpha": 1,
                "mod:扩展/单极磁石": 2,
                "omega": 3
            },
            "inputs": {
                "alpha": 4,
                "mod:扩展/单极磁石": 5,
                "omega": 6
            }
        });
        let entity = entity.as_object_mut().unwrap();
        let output_order_before = entity["outputs"]
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        let input_order_before = entity["inputs"]
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        let output_key_before = item_key_pointer(entity["outputs"].as_object().unwrap(), item_id);
        let input_key_before = item_key_pointer(entity["inputs"].as_object().unwrap(), item_id);

        set_output(entity, item_id, -0.0).unwrap();
        add_input(entity, item_id, 3.75).unwrap();

        let outputs = entity["outputs"].as_object().unwrap();
        let inputs = entity["inputs"].as_object().unwrap();
        assert_eq!(item_key_pointer(outputs, item_id), output_key_before);
        assert_eq!(item_key_pointer(inputs, item_id), input_key_before);
        assert_eq!(
            outputs.keys().cloned().collect::<Vec<_>>(),
            output_order_before
        );
        assert_eq!(
            inputs.keys().cloned().collect::<Vec<_>>(),
            input_order_before
        );
        assert_eq!(
            outputs[item_id].as_f64().unwrap().to_bits(),
            (-0.0_f64).to_bits()
        );
        assert_eq!(inputs[item_id], 8.0);
    }

    #[test]
    fn missing_transfer_item_keys_keep_legacy_map_order_and_flooring() {
        let item_id = "mod:扩展/β-矿物";
        let mut actual = json!({
            "outputs": { "alpha": 1, "omega": 3 },
            "inputs": { "alpha": 4, "omega": 6 }
        });
        let mut expected = actual.clone();

        set_output(actual.as_object_mut().unwrap(), item_id, 7.25).unwrap();
        add_input(actual.as_object_mut().unwrap(), item_id, 3.75).unwrap();
        legacy_set_output(expected.as_object_mut().unwrap(), item_id, 7.25).unwrap();
        legacy_add_input(expected.as_object_mut().unwrap(), item_id, 3.75).unwrap();

        assert_eq!(
            serde_json::to_string(&actual).unwrap(),
            serde_json::to_string(&expected).unwrap()
        );
        assert_eq!(actual["outputs"][item_id], 7.25);
        assert_eq!(actual["inputs"][item_id], 3.0);
    }

    #[test]
    fn transfer_item_mutations_match_legacy_deterministic_oracle() {
        let item_ids = ["iron_ingot", "mod:item/量子-β", "emoji/🚀"];
        let existing_values = [
            None,
            Some(Value::Null),
            Some(Value::Bool(true)),
            Some(Value::from("invalid")),
            Some(Value::from(-0.0)),
            Some(Value::from(2.75)),
            Some(Value::from(9_007_199_254_740_000.0)),
        ];
        let finite_amounts = [-0.0, 0.0, 0.25, 1.0, 17.875, 1_000_000.0];

        for (case, item_id) in item_ids.into_iter().enumerate() {
            for (existing_index, existing) in existing_values.iter().enumerate() {
                for (amount_index, amount) in finite_amounts.into_iter().enumerate() {
                    let mut actual = json!({
                        "outputs": { "aaa": 1, "mod:keep/中": 2, "zzz": 3 },
                        "inputs": { "aaa": 4, "mod:keep/中": 5, "zzz": 6 }
                    });
                    if let Some(value) = existing {
                        actual["outputs"]
                            .as_object_mut()
                            .unwrap()
                            .insert(item_id.to_owned(), value.clone());
                        actual["inputs"]
                            .as_object_mut()
                            .unwrap()
                            .insert(item_id.to_owned(), value.clone());
                    }
                    let mut expected = actual.clone();
                    let output_amount = amount + f64::from(u32::try_from(case).unwrap()) / 8.0;

                    let actual_output =
                        set_output(actual.as_object_mut().unwrap(), item_id, output_amount);
                    let expected_output = legacy_set_output(
                        expected.as_object_mut().unwrap(),
                        item_id,
                        output_amount,
                    );
                    let actual_input = add_input(actual.as_object_mut().unwrap(), item_id, amount);
                    let expected_input =
                        legacy_add_input(expected.as_object_mut().unwrap(), item_id, amount);

                    assert_eq!(
                        actual_output.as_ref().err().map(ToString::to_string),
                        expected_output.as_ref().err().map(ToString::to_string),
                        "output case={case} existing={existing_index} amount={amount_index}"
                    );
                    assert_eq!(
                        actual_input.as_ref().err().map(ToString::to_string),
                        expected_input.as_ref().err().map(ToString::to_string),
                        "input case={case} existing={existing_index} amount={amount_index}"
                    );
                    assert_eq!(
                        serde_json::to_string(&actual).unwrap(),
                        serde_json::to_string(&expected).unwrap(),
                        "state case={case} existing={existing_index} amount={amount_index}"
                    );
                }
            }
        }
    }

    #[test]
    fn transfer_item_errors_preserve_validation_order_and_source_state() {
        for amount in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            let mut missing = json!({});
            assert_eq!(
                set_output(missing.as_object_mut().unwrap(), "mod:物料", amount)
                    .unwrap_err()
                    .to_string(),
                "native belt source outputs are missing"
            );
            assert_eq!(
                add_input(missing.as_object_mut().unwrap(), "mod:物料", amount)
                    .unwrap_err()
                    .to_string(),
                "native belt target inputs are missing"
            );
            assert_eq!(missing, json!({}));

            let mut populated = json!({
                "outputs": { "mod:物料": -0.0, "preserve": 1 },
                "inputs": { "mod:物料": -0.0, "preserve": 2 }
            });
            let before = serde_json::to_string(&populated).unwrap();
            assert_eq!(
                set_output(populated.as_object_mut().unwrap(), "mod:物料", amount)
                    .unwrap_err()
                    .to_string(),
                "native belt output is non-finite"
            );
            assert_eq!(
                add_input(populated.as_object_mut().unwrap(), "mod:物料", amount)
                    .unwrap_err()
                    .to_string(),
                "native belt input is non-finite"
            );
            assert_eq!(serde_json::to_string(&populated).unwrap(), before);
        }
    }

    #[allow(dead_code)]
    #[repr(C)]
    struct LegacyRouteLayout {
        belt_index: usize,
        source_index: usize,
        target_index: usize,
        source_group: usize,
        target_slot: usize,
        belt_sort_rank: usize,
        target_port_index: Option<u8>,
        capacity: f64,
        priority: usize,
    }

    #[allow(dead_code)]
    #[repr(C)]
    struct LegacyPreparedGroupLayout {
        source_index: usize,
        item_symbol: u32,
        balanced_splitter: bool,
        route_indices: Vec<usize>,
    }

    #[test]
    fn compact_topology_layout_saves_at_least_six_mib_at_stress_route_count() {
        assert_eq!(size_of::<Route>(), 32);
        assert_eq!(size_of::<LegacyRouteLayout>(), 72);
        assert_eq!(size_of::<PreparedGroup>(), 32);
        assert_eq!(size_of::<LegacyPreparedGroupLayout>(), 40);
        assert_eq!(size_of::<((u32, u32), u32)>(), 12);
        assert_eq!(size_of::<((usize, u32), usize)>(), 24);
        let route_count = 155_746_usize;
        let group_count = 78_025_usize;
        let legacy_bytes = route_count * (size_of::<LegacyRouteLayout>() + size_of::<usize>());
        let compact_bytes = route_count * (size_of::<Route>() + size_of::<u32>());
        let group_layout_savings =
            group_count * (size_of::<LegacyPreparedGroupLayout>() - size_of::<PreparedGroup>());
        let conservative_savings = legacy_bytes - compact_bytes + group_layout_savings;
        assert!(
            conservative_savings >= 6 * 1024 * 1024,
            "saved {} bytes",
            conservative_savings
        );
        assert_eq!(conservative_savings, 7_477_024);
        assert!(29_165_040_usize - conservative_savings <= 22_873_584);
    }

    #[test]
    fn compact_topology_indices_fail_closed_above_u32() {
        let maximum = usize::try_from(u32::MAX).unwrap();
        assert_eq!(compact_index(maximum, "test index").unwrap(), u32::MAX);
        assert_eq!(expand_compact_index(u32::MAX), maximum);
        let overflow = usize::try_from(u64::from(u32::MAX) + 1).unwrap();
        let error = compact_index(overflow, "test index").unwrap_err();
        assert!(error.to_string().contains("compact topology limit"));
    }

    #[test]
    fn compact_route_order_matches_random_legacy_usize_oracle() {
        let mut seed = 0xe5_be_17_c0_6d_5e_47_u64;
        for case in 0..512 {
            let route_count = 1 + usize::try_from(xorshift64(&mut seed) % 257)
                .expect("bounded random route count fits usize");
            let group_count = 1 + usize::try_from(xorshift64(&mut seed) % 19)
                .expect("bounded random group count fits usize");
            let mut belt_ids = Vec::<Box<str>>::with_capacity(route_count);
            let mut routes = Vec::<Route>::with_capacity(route_count);
            let mut groups = (0..group_count)
                .map(|group_index| PreparedGroup {
                    source_index: compact_index(group_index, "test source index").unwrap(),
                    item_symbol: u32::try_from(group_index % 7).unwrap(),
                    balanced_splitter: group_index % 3 == 0,
                    always_awake: false,
                    route_indices: Box::default(),
                })
                .collect::<Vec<_>>();
            let mut compact_group_routes = vec![Vec::<u32>::new(); group_count];
            let mut legacy_groups = vec![Vec::<usize>::new(); group_count];

            for route_index in 0..route_count {
                let group_index =
                    usize::try_from(xorshift64(&mut seed) % u64::try_from(group_count).unwrap())
                        .unwrap();
                let lexical = xorshift64(&mut seed) % 43;
                let namespace = if xorshift64(&mut seed).is_multiple_of(2) {
                    "mod:扩展"
                } else {
                    "base"
                };
                belt_ids.push(
                    format!("{namespace}/belt-{lexical:02}-{route_index:04}-{case:03}")
                        .into_boxed_str(),
                );
                routes.push(Route {
                    capacity: 1.0 + f64::from(u32::try_from(route_index % 17).unwrap()),
                    source_index: compact_index(group_index, "test source index").unwrap(),
                    target_index: compact_index(route_count - route_index - 1, "test target index")
                        .unwrap(),
                    source_group: compact_index(group_index, "test source group").unwrap(),
                    target_slot: compact_index(route_index % 23, "test target slot").unwrap(),
                    belt_sort_rank: 0,
                    target_port_index: u8::try_from(route_index % 5).ok(),
                    priority: u8::try_from(route_index % 3).unwrap(),
                });
                let compact_route_index = compact_index(route_index, "test route index").unwrap();
                compact_group_routes[group_index].push(compact_route_index);
                legacy_groups[group_index].push(route_index);
            }
            for (group, route_indices) in groups.iter_mut().zip(compact_group_routes) {
                group.route_indices = route_indices.into_boxed_slice();
            }

            let mut legacy_ranks = vec![0_usize; route_count];
            for group in &mut legacy_groups {
                group.sort_by(|left, right| belt_ids[*left].cmp(&belt_ids[*right]));
                for (rank, route_index) in group.iter().copied().enumerate() {
                    legacy_ranks[route_index] = rank;
                }
            }
            sort_prepared_group_routes(&mut routes, &mut groups, &belt_ids).unwrap();

            for (group, legacy_group) in groups.iter().zip(&legacy_groups) {
                let expanded = group
                    .route_indices
                    .iter()
                    .copied()
                    .map(expand_compact_index)
                    .collect::<Vec<_>>();
                assert_eq!(&expanded, legacy_group, "case={case}");
            }
            for (route_index, route) in routes.iter().enumerate() {
                assert_eq!(
                    route.belt_sort_rank(),
                    legacy_ranks[route_index],
                    "case={case}"
                );
                assert_eq!(route.source_group(), route.source_index(), "case={case}");
            }
        }
    }

    fn empty_prepared_routes() -> PreparedRoutes {
        PreparedRoutes {
            routes: Vec::new(),
            groups: Vec::new(),
            target_slot_count: 0,
            total_capacity: 0.0,
            group_by_key: Arc::new(HashMap::new()),
        }
    }

    #[test]
    fn carried_activity_moves_factory_sized_workspace_once_without_reinitializing_rows() {
        let belt_count = 4_097;
        let target_slot_count = 257;
        let mut prepared = kernel_prepared_routes(belt_count);
        prepared.groups = vec![
            PreparedGroup {
                source_index: 0,
                item_symbol: 0,
                balanced_splitter: false,
                always_awake: false,
                route_indices: vec![0].into_boxed_slice(),
            },
            PreparedGroup {
                source_index: 1,
                item_symbol: 0,
                balanced_splitter: false,
                always_awake: false,
                route_indices: vec![1].into_boxed_slice(),
            },
            PreparedGroup {
                source_index: 2,
                item_symbol: 0,
                balanced_splitter: false,
                always_awake: false,
                route_indices: vec![2].into_boxed_slice(),
            },
        ];
        prepared.target_slot_count = compact_index(target_slot_count, "test target slots").unwrap();
        let prepared = Arc::new(prepared);

        let mut first = BeltRuntime::empty(belt_count, &prepared);
        first.active_groups[0] = true;
        first.active_groups[2] = true;
        first.active_group_indices = vec![0, 2];
        let post_actions_ptr = first.workspace.post_actions.as_ptr();
        let groups_ptr = first.workspace.groups.as_ptr();
        let target_free_ptr = first.workspace.target_free.as_ptr();
        assert!(!first.diagnostics.runtime_workspace_reused);
        assert_eq!(
            first.diagnostics.runtime_workspace_initialized_route_rows,
            belt_count
        );
        assert_eq!(
            first.diagnostics.runtime_workspace_initialized_group_rows,
            3
        );
        assert_eq!(
            first.diagnostics.runtime_workspace_initialized_target_rows,
            target_slot_count
        );

        let snapshot = first.activity_snapshot(&prepared);
        assert!(
            snapshot.estimated_bytes()
                >= (belt_count * size_of::<BeltPostAction>() + target_slot_count * size_of::<f64>())
                    as u64
        );
        let reusable = snapshot.take_reusable_runtime().unwrap();
        let second = BeltRuntime::empty_with_reusable(belt_count, &prepared, Some(reusable));

        assert!(second.diagnostics.runtime_workspace_reused);
        assert_eq!(
            second.diagnostics.runtime_workspace_initialized_route_rows,
            0
        );
        assert_eq!(
            second.diagnostics.runtime_workspace_initialized_group_rows,
            0
        );
        assert_eq!(
            second.diagnostics.runtime_workspace_initialized_target_rows,
            0
        );
        // Pool provenance is cleared before a borrower seeds its own immutable
        // snapshot indices in finish_activity.
        assert_eq!(second.active_groups, [false, false, false]);
        assert_eq!(second.workspace.post_actions.as_ptr(), post_actions_ptr);
        assert_eq!(second.workspace.groups.as_ptr(), groups_ptr);
        assert_eq!(second.workspace.target_free.as_ptr(), target_free_ptr);
        assert!(snapshot.take_reusable_runtime().is_none());
        assert_eq!(snapshot.estimated_bytes(), (2 * size_of::<u32>()) as u64);
    }

    #[test]
    fn failed_and_discarded_candidates_return_clean_clone_safe_workspace() {
        let belt_count = 128;
        let target_slot_count = 8;
        let mut prepared = kernel_prepared_routes(belt_count);
        prepared.groups = (0..3)
            .map(|index| PreparedGroup {
                source_index: compact_index(index, "pool test source").unwrap(),
                item_symbol: 0,
                balanced_splitter: false,
                always_awake: false,
                route_indices: vec![compact_index(index, "pool test route").unwrap()]
                    .into_boxed_slice(),
            })
            .collect();
        prepared.target_slot_count = compact_index(target_slot_count, "pool test targets").unwrap();
        let prepared = Arc::new(prepared);

        let mut first = BeltRuntime::empty(belt_count, &prepared);
        first.active_groups[0] = true;
        first.active_groups[2] = true;
        first.active_group_indices = vec![0, 2];
        let post_actions_ptr = first.workspace.post_actions.as_ptr();
        let selected_groups_ptr = first.workspace.selected_group_indices.as_ptr();
        let selected_routes_ptr = first.workspace.selected_route_indices.as_ptr();
        let pending_wakes_ptr = first.workspace.pending_wake_group_indices.as_ptr();
        let original = first.activity_snapshot(&prepared);
        let pool = Arc::clone(&original.reusable_pool);

        let reusable = original.take_reusable_runtime().unwrap();
        let mut failed = BeltRuntime::empty_with_reusable(belt_count, &prepared, Some(reusable));
        failed.reusable_pool = Some(Arc::clone(&pool));
        failed.active_queue_enabled = true;
        failed.active_groups[1] = true;
        failed.active_group_indices = vec![1];
        failed.workspace.post_actions[7] = BeltPostAction::ResetProgress;
        failed.workspace.target_free[2] = 1.0;
        failed.workspace.touched_target_slots.push(2);
        failed.workspace.groups[1].reset(5.0, true);
        failed.workspace.groups[1].inactive_routes.push(1);
        failed.workspace.usable_candidate_indices.push(1);
        failed.workspace.active_candidate_indices.push(1);
        let injected =
            with_active_selection(&mut failed, &prepared, |runtime, _| -> anyhow::Result<()> {
                runtime.workspace.pending_wake_group_indices.push(1);
                bail!("injected reusable candidate failure")
            });
        assert_eq!(
            injected.unwrap_err().to_string(),
            "injected reusable candidate failure"
        );
        assert_eq!(
            failed.workspace.selected_route_indices.as_ptr(),
            selected_routes_ptr,
            "Result failure must recycle selection scratch before runtime rollback"
        );
        drop(failed);

        let returned = original.take_reusable_runtime().unwrap();
        assert_eq!(returned.workspace.post_actions.as_ptr(), post_actions_ptr);
        assert_eq!(
            returned.workspace.selected_group_indices.as_ptr(),
            selected_groups_ptr
        );
        assert_eq!(
            returned.workspace.selected_route_indices.as_ptr(),
            selected_routes_ptr
        );
        assert_eq!(
            returned.workspace.pending_wake_group_indices.as_ptr(),
            pending_wakes_ptr
        );
        assert!(returned.active_groups.iter().all(|active| !*active));
        assert!(returned.occupied_group_indices.is_empty());
        assert!(
            returned
                .workspace
                .post_actions
                .iter()
                .all(|action| matches!(action, BeltPostAction::None))
        );
        assert!(
            returned
                .workspace
                .target_free
                .iter()
                .all(|free| free.is_nan())
        );
        assert!(returned.workspace.touched_target_slots.is_empty());
        assert!(returned.workspace.groups.iter().all(|group| {
            group.available == 0.0
                && !group.source_had_output
                && group.first_candidate.is_none()
                && group.candidates.is_empty()
                && group.first_inactive_route.is_none()
                && group.inactive_routes.is_empty()
        }));
        assert!(returned.workspace.usable_candidate_indices.is_empty());
        assert!(returned.workspace.active_candidate_indices.is_empty());
        assert!(returned.workspace.selected_group_indices.is_empty());
        assert!(returned.workspace.selected_route_indices.is_empty());
        assert!(returned.workspace.pending_wake_group_indices.is_empty());

        let mut discarded = BeltRuntime::empty_with_reusable(belt_count, &prepared, Some(returned));
        discarded.reusable_pool = Some(Arc::clone(&pool));
        discarded.active_groups[1] = true;
        discarded.active_group_indices = vec![1];
        let child = discarded.activity_snapshot(&prepared);
        assert!(Arc::ptr_eq(&child.reusable_pool, &original.reusable_pool));
        assert_eq!(&*child.active_group_indices, &[1]);
        drop(child);

        let divergent = original.take_reusable_runtime().unwrap();
        assert_eq!(&*divergent.occupied_group_indices, &[1]);
        assert_eq!(divergent.active_groups, [false, true, false]);
        let mut retargeted =
            BeltRuntime::empty_with_reusable(belt_count, &prepared, Some(divergent));
        assert_eq!(retargeted.active_groups, [false, false, false]);
        assert!(retargeted.diagnostics.runtime_workspace_reused);
        assert_eq!(
            retargeted
                .diagnostics
                .runtime_workspace_initialized_route_rows,
            0
        );
        assert_eq!(
            retargeted
                .diagnostics
                .runtime_workspace_initialized_group_rows,
            0
        );
        assert_eq!(
            retargeted
                .diagnostics
                .runtime_workspace_initialized_target_rows,
            0
        );
        assert_eq!(retargeted.workspace.post_actions.as_ptr(), post_actions_ptr);
        assert_eq!(
            retargeted.workspace.selected_group_indices.as_ptr(),
            selected_groups_ptr
        );
        assert_eq!(
            retargeted.workspace.selected_route_indices.as_ptr(),
            selected_routes_ptr
        );
        assert_eq!(
            retargeted.workspace.pending_wake_group_indices.as_ptr(),
            pending_wakes_ptr
        );

        // The real success path publishes its activity snapshot before belt
        // patch sealing. A later write-back error must leave the shared pool
        // reachable through the source snapshot rather than drain it.
        retargeted.reusable_pool = Some(Arc::clone(&pool));
        retargeted.active_groups[0] = true;
        retargeted.active_group_indices = vec![0];
        let failed_writeback_snapshot = retargeted.activity_snapshot(&prepared);
        let (zero_belt_state, _) = builtin_ordinary_machine_state(0.0);
        let writeback_error = retargeted
            .into_patches(&zero_belt_state, BeltFlowRequirement::NotRequired)
            .unwrap_err();
        assert!(
            writeback_error
                .to_string()
                .contains("native belt runtime source changed before commit sealing")
        );
        drop(failed_writeback_snapshot);
        let after_writeback_failure = original.take_reusable_runtime().unwrap();
        assert_eq!(
            after_writeback_failure.workspace.post_actions.as_ptr(),
            post_actions_ptr
        );
        assert_eq!(&*after_writeback_failure.occupied_group_indices, &[0]);
    }

    #[test]
    fn overlapping_candidate_returns_keep_the_first_valid_pool_slot() {
        let belt_count = 128;
        let mut prepared = kernel_prepared_routes(belt_count);
        prepared.groups = (0..2)
            .map(|index| PreparedGroup {
                source_index: compact_index(index, "overlap pool source").unwrap(),
                item_symbol: 0,
                balanced_splitter: false,
                always_awake: false,
                route_indices: vec![compact_index(index, "overlap pool route").unwrap()]
                    .into_boxed_slice(),
            })
            .collect();
        prepared.target_slot_count = 2;
        let prepared = Arc::new(prepared);

        let mut seed = BeltRuntime::empty(belt_count, &prepared);
        seed.active_groups[0] = true;
        seed.active_group_indices = vec![0];
        let source = seed.activity_snapshot(&prepared);
        let pool = Arc::clone(&source.reusable_pool);

        let resident = source.take_reusable_runtime().unwrap();
        let mut first = BeltRuntime::empty_with_reusable(belt_count, &prepared, Some(resident));
        first.reusable_pool = Some(Arc::clone(&pool));
        first.active_groups[0] = true;
        first.active_group_indices = vec![0];

        // The pool is checked out, so an overlapping disposable clone gets a
        // correctly sized fresh workspace. Returning this clone first must
        // occupy the one slot; the later original return may not overwrite it.
        assert!(source.take_reusable_runtime().is_none());
        let mut second = BeltRuntime::empty_with_reusable(belt_count, &prepared, None);
        second.reusable_pool = Some(Arc::clone(&pool));
        second.active_groups[1] = true;
        second.active_group_indices = vec![1];
        let second_post_actions_ptr = second.workspace.post_actions.as_ptr();
        let second_snapshot = second.activity_snapshot(&prepared);
        let first_snapshot = first.activity_snapshot(&prepared);
        assert!(Arc::ptr_eq(
            &first_snapshot.reusable_pool,
            &second_snapshot.reusable_pool
        ));
        drop(first_snapshot);
        drop(second_snapshot);

        let winner = source.take_reusable_runtime().unwrap();
        assert_eq!(
            winner.workspace.post_actions.as_ptr(),
            second_post_actions_ptr
        );
        assert_eq!(&*winner.occupied_group_indices, &[1]);
        assert_eq!(winner.active_groups, [false, true]);
        let retargeted = BeltRuntime::empty_with_reusable(belt_count, &prepared, Some(winner));
        assert_eq!(retargeted.active_groups, [false, false]);
        assert_eq!(
            retargeted.workspace.post_actions.as_ptr(),
            second_post_actions_ptr
        );
    }

    #[test]
    fn concurrent_candidate_checkouts_share_no_mutable_workspace() {
        let belt_count = 128;
        let mut prepared = kernel_prepared_routes(belt_count);
        prepared.groups = (0..2)
            .map(|index| PreparedGroup {
                source_index: compact_index(index, "concurrent pool source").unwrap(),
                item_symbol: 0,
                balanced_splitter: false,
                always_awake: false,
                route_indices: vec![compact_index(index, "concurrent pool route").unwrap()]
                    .into_boxed_slice(),
            })
            .collect();
        prepared.target_slot_count = 2;
        let prepared = Arc::new(prepared);

        let mut seed = BeltRuntime::empty(belt_count, &prepared);
        seed.active_groups[0] = true;
        seed.active_group_indices = vec![0];
        let source = seed.activity_snapshot(&prepared);
        let pool = Arc::clone(&source.reusable_pool);
        let start = Arc::new(std::sync::Barrier::new(3));
        let borrowed = Arc::new(std::sync::Barrier::new(3));

        let spawn_candidate = |group_index: usize| {
            let prepared = Arc::clone(&prepared);
            let pool = Arc::clone(&pool);
            let start = Arc::clone(&start);
            let borrowed = Arc::clone(&borrowed);
            std::thread::spawn(move || {
                start.wait();
                let reusable = pool.take();
                let reused = reusable.is_some();
                let mut runtime = BeltRuntime::empty_with_reusable(belt_count, &prepared, reusable);
                runtime.reusable_pool = Some(Arc::clone(&pool));
                runtime.active_groups[group_index] = true;
                runtime.active_group_indices = vec![group_index as u32];
                // Both candidates must complete checkout before either can
                // publish, proving that only one owns the resident workspace.
                borrowed.wait();
                let snapshot = runtime.activity_snapshot(&prepared);
                (reused, snapshot)
            })
        };

        let first = spawn_candidate(0);
        let second = spawn_candidate(1);
        start.wait();
        borrowed.wait();
        let (first_reused, first_snapshot) = first.join().unwrap();
        let (second_reused, second_snapshot) = second.join().unwrap();
        assert_ne!(first_reused, second_reused);
        assert!(Arc::ptr_eq(
            &first_snapshot.reusable_pool,
            &second_snapshot.reusable_pool
        ));
        drop(first_snapshot);
        drop(second_snapshot);

        let winner = source.take_reusable_runtime().unwrap();
        assert!(matches!(&*winner.occupied_group_indices, [0] | [1]));
        let winner_group = winner.occupied_group_indices[0] as usize;
        assert_eq!(winner.active_groups, [winner_group == 0, winner_group == 1]);
        let retargeted = BeltRuntime::empty_with_reusable(belt_count, &prepared, Some(winner));
        assert!(retargeted.diagnostics.runtime_workspace_reused);
        assert_eq!(retargeted.active_groups, [false, false]);
        assert_eq!(
            retargeted
                .diagnostics
                .runtime_workspace_initialized_route_rows,
            0
        );
        assert_eq!(
            retargeted
                .diagnostics
                .runtime_workspace_initialized_group_rows,
            0
        );
        assert_eq!(
            retargeted
                .diagnostics
                .runtime_workspace_initialized_target_rows,
            0
        );
    }

    #[test]
    fn persisted_signal_bits_match_legacy_missing_and_negative_zero_rules() {
        let routes = empty_prepared_routes();
        let mut runtime = BeltRuntime::empty(3, &routes);
        let mut persisted = BeltDynamicColumns::default();
        for record in [
            json!({"progress":-0.0,"totalTransferred":7,"congestion":0,"lastFlow":0}),
            json!({"totalTransferred":7,"congestion":0,"lastFlow":0}),
            json!({"progress":0,"congestion":0,"lastFlow":0}),
        ] {
            persisted
                .push_from_object(record.as_object().unwrap())
                .unwrap();
        }
        runtime.progress.clone_from(&persisted.progress);
        runtime
            .total_transferred
            .clone_from(&persisted.total_transferred);
        runtime.congestion.clone_from(&persisted.congestion);
        runtime.last_flow.clone_from(&persisted.last_flow);

        assert!(!runtime.record_needs_write(&persisted, 0));
        assert!(runtime.record_needs_write(&persisted, 1));
        assert!(!runtime.record_needs_write(&persisted, 2));
        runtime.total_dirty[2] = true;
        assert!(runtime.record_needs_write(&persisted, 2));
        runtime.total_dirty[0] = true;
        assert!(!runtime.record_needs_write(&persisted, 0));
        runtime.progress[0] = 0.0;
        assert!(runtime.record_needs_write(&persisted, 0));
    }

    #[test]
    fn raw_dynamic_patch_matches_legacy_value_semantics_for_random_records() {
        let numeric_or_invalid = [
            "0",
            "-0.0",
            "1e3",
            "2.5",
            "9.007199254740991e15",
            "null",
            "\"mod\"",
        ];
        let mut seed = 0xd5_50_1d_1e_47_u64;
        for case in 0..2_048 {
            let mut members = vec![
                format!("\"id\":\"belt-{case}\""),
                format!(
                    "\"modPayload\":{{\"nested\":[{},{{\"escaped\":\"\\u4e2d\\/x\"}}]}}",
                    xorshift64(&mut seed) % 97
                ),
                format!("\"planetId\":\"planet-{}\"", xorshift64(&mut seed) % 11),
            ];
            for (slot, key) in ["progress", "totalTransferred", "congestion", "lastFlow"]
                .into_iter()
                .enumerate()
            {
                if !xorshift64(&mut seed).is_multiple_of(5) {
                    let value = numeric_or_invalid
                        [(xorshift64(&mut seed) as usize) % numeric_or_invalid.len()];
                    members.push(format!("\"{key}\":{value}"));
                    if xorshift64(&mut seed).is_multiple_of(7) {
                        let duplicate_key = if slot == BeltDynamicColumns::PROGRESS {
                            "pro\\u0067ress"
                        } else {
                            key
                        };
                        let duplicate_value = numeric_or_invalid
                            [(xorshift64(&mut seed) as usize) % numeric_or_invalid.len()];
                        members.push(format!("\"{duplicate_key}\":{duplicate_value}"));
                    }
                }
            }
            for index in (1..members.len()).rev() {
                let swap = (xorshift64(&mut seed) as usize) % (index + 1);
                members.swap(index, swap);
            }
            let raw = format!("{{ {} }}", members.join(", \n  "));
            let patch = BeltDynamicRawPatch {
                progress: Some(if xorshift64(&mut seed) & 1 == 0 {
                    -0.0
                } else {
                    (xorshift64(&mut seed) % 10_000) as f64 / 13.0
                }),
                total_transferred: xorshift64(&mut seed)
                    .is_multiple_of(3)
                    .then(|| (xorshift64(&mut seed) % 1_000_000) as f64),
                congestion: Some((xorshift64(&mut seed) % 1_001) as f64 / 1_000.0),
                last_flow: Some((xorshift64(&mut seed) % 100_000) as f64 / 17.0),
            };
            let rewritten = materialize_rewrite(&raw, patch);
            let actual: Value = serde_json::from_str(&rewritten).unwrap();
            assert_eq!(actual, legacy_dynamic_patch(&raw, patch), "case={case}");
        }
    }

    #[test]
    fn raw_dynamic_patch_preserves_mod_payload_order_and_escapes_byte_exact() {
        let mod_member =
            r#""mod\u0050ayload" : { "escaped" : "\u4e2d\/x", "nested" : [1,{"keep":true}] }"#;
        let raw = format!(
            "{{\"id\":\"belt\\u002desc\", \"alpha\":1, \"progress\" : 2e0, {mod_member}, \"omega\":3}}"
        );
        let rewritten = materialize_rewrite(
            &raw,
            BeltDynamicRawPatch {
                progress: Some(7.25),
                congestion: Some(0.0),
                last_flow: Some(-0.0),
                ..BeltDynamicRawPatch::default()
            },
        );

        assert!(rewritten.contains(mod_member));
        let alpha = rewritten.find("\"alpha\"").unwrap();
        let progress = rewritten.find("\"progress\"").unwrap();
        let mod_payload = rewritten.find("\"mod\\u0050ayload\"").unwrap();
        let omega = rewritten.find("\"omega\"").unwrap();
        assert!(alpha < progress && progress < mod_payload && mod_payload < omega);
        assert!(rewritten.contains("\"id\":\"belt\\u002desc\""));
        let parsed: Value = serde_json::from_str(&rewritten).unwrap();
        assert_eq!(parsed["modPayload"]["nested"][1]["keep"], true);
    }

    #[test]
    fn raw_dynamic_patch_collapses_known_duplicates_with_last_value_at_first_position() {
        let raw = r#"{"id":"first","progress":1,"mod":{"progress":999},"pro\u0067ress":2,"id":"belt","lastFlow":3,"lastFlow":4}"#;
        let rewritten = materialize_rewrite(raw, BeltDynamicRawPatch::default());
        let (_, _, members) = scan_belt_raw_object(&rewritten).unwrap();
        assert_eq!(
            members
                .iter()
                .filter(|member| member.field == BeltRawField::Id)
                .count(),
            1
        );
        assert_eq!(
            members
                .iter()
                .filter(|member| {
                    member.field == BeltRawField::Dynamic(BeltDynamicColumns::PROGRESS)
                })
                .count(),
            1
        );
        assert_eq!(
            members
                .iter()
                .filter(|member| {
                    member.field == BeltRawField::Dynamic(BeltDynamicColumns::LAST_FLOW)
                })
                .count(),
            1
        );
        let parsed: Value = serde_json::from_str(&rewritten).unwrap();
        assert_eq!(parsed["id"], "belt");
        assert_eq!(parsed["progress"], 2);
        assert_eq!(parsed["lastFlow"], 4);
        assert_eq!(parsed["mod"]["progress"], 999);
        assert!(rewritten.find("\"progress\"").unwrap() < rewritten.find("\"mod\"").unwrap());
    }

    #[test]
    fn raw_dynamic_patch_keeps_missing_null_negative_zero_and_exponent_rules() {
        let raw =
            r#"{"id":"belt","totalTransferred":null,"congestion":-0.0,"lastFlow":1e3,"mod":true}"#;
        assert!(
            rewrite_belt_dynamic_raw(raw, BeltDynamicRawPatch::default())
                .unwrap()
                .is_none()
        );
        let rewritten = materialize_rewrite(
            raw,
            BeltDynamicRawPatch {
                progress: Some(-0.0),
                congestion: Some(-0.0),
                last_flow: Some(1_000.0),
                ..BeltDynamicRawPatch::default()
            },
        );
        let parsed: Value = serde_json::from_str(&rewritten).unwrap();
        assert!(parsed["totalTransferred"].is_null());
        assert_eq!(
            parsed["progress"].as_f64().unwrap().to_bits(),
            (-0.0_f64).to_bits()
        );
        assert_eq!(
            parsed["congestion"].as_f64().unwrap().to_bits(),
            (-0.0_f64).to_bits()
        );
        assert_eq!(parsed["lastFlow"], 1_000.0);
        assert_eq!(parsed["mod"], true);
    }

    #[test]
    fn raw_dynamic_patch_rejects_malformed_non_object_and_non_finite_candidates() {
        assert!(rewrite_belt_dynamic_raw("{", BeltDynamicRawPatch::default()).is_err());
        assert!(rewrite_belt_dynamic_raw("[]", BeltDynamicRawPatch::default()).is_err());
        assert!(
            rewrite_belt_dynamic_raw(
                "{}",
                BeltDynamicRawPatch {
                    progress: Some(f64::NAN),
                    ..BeltDynamicRawPatch::default()
                }
            )
            .is_err()
        );
    }

    #[test]
    fn workspace_reset_retains_flat_and_group_allocations() {
        let mut workspace = BeltWorkspace::new(4, 2, 3);
        workspace.post_actions[1] = BeltPostAction::ResetProgress;
        workspace.target_free[2] = 12.0;
        workspace.touched_target_slots.push(2);
        workspace.usable_candidate_indices.extend([1, 2, 3]);
        workspace.active_candidate_indices.extend([2, 3]);
        workspace.groups[0].candidates.extend([
            Candidate {
                route_index: 1,
                allowance: 2.0,
                moved: 0.0,
            },
            Candidate {
                route_index: 2,
                allowance: 3.0,
                moved: 1.0,
            },
        ]);
        workspace.groups[0].inactive_routes.extend([4, 5]);
        let usable_capacity = workspace.usable_candidate_indices.capacity();
        let active_capacity = workspace.active_candidate_indices.capacity();
        let candidate_capacity = workspace.groups[0].candidates.capacity();
        let inactive_capacity = workspace.groups[0].inactive_routes.capacity();

        workspace.reset_transfer_buffers(&empty_prepared_routes(), &ActiveSelection::All);
        workspace.groups[0].reset(7.0, true);

        assert!(
            workspace
                .post_actions
                .iter()
                .all(|action| matches!(action, BeltPostAction::None))
        );
        assert!(workspace.target_free.iter().all(|free| free.is_nan()));
        assert!(workspace.usable_candidate_indices.is_empty());
        assert!(workspace.active_candidate_indices.is_empty());
        assert_eq!(
            workspace.usable_candidate_indices.capacity(),
            usable_capacity
        );
        assert_eq!(
            workspace.active_candidate_indices.capacity(),
            active_capacity
        );
        assert!(workspace.groups[0].candidates.is_empty());
        assert!(workspace.groups[0].inactive_routes.is_empty());
        assert_eq!(
            workspace.groups[0].candidates.capacity(),
            candidate_capacity
        );
        assert_eq!(
            workspace.groups[0].inactive_routes.capacity(),
            inactive_capacity
        );
        assert_eq!(workspace.groups[0].available, 7.0);
        assert!(workspace.groups[0].source_had_output);
    }

    #[test]
    fn sparse_workspace_reset_only_visits_selected_route_rows() {
        let route = |source_group: usize, belt_sort_rank: usize| Route {
            capacity: 1.0,
            source_index: compact_index(source_group, "test source index").unwrap(),
            target_index: 0,
            source_group: compact_index(source_group, "test source group").unwrap(),
            target_slot: 0,
            belt_sort_rank: compact_index(belt_sort_rank, "test belt rank").unwrap(),
            target_port_index: None,
            priority: 1,
        };
        let prepared = PreparedRoutes {
            routes: vec![route(0, 0), route(1, 0), route(1, 1), route(0, 1)],
            groups: vec![
                PreparedGroup {
                    source_index: 0,
                    item_symbol: 0,
                    balanced_splitter: false,
                    always_awake: false,
                    route_indices: vec![0, 3].into_boxed_slice(),
                },
                PreparedGroup {
                    source_index: 1,
                    item_symbol: 0,
                    balanced_splitter: false,
                    always_awake: false,
                    route_indices: vec![1, 2].into_boxed_slice(),
                },
            ],
            target_slot_count: 1,
            total_capacity: 4.0,
            group_by_key: Arc::new(HashMap::new()),
        };
        let selection = ActiveSelection::Mask {
            selected_group_indices: vec![1],
            selected_route_indices: vec![1, 2],
        };
        let mut workspace = BeltWorkspace::new(4, 2, 1);
        workspace.post_actions.fill(BeltPostAction::ResetProgress);
        workspace.target_free[0] = 7.0;
        workspace.touched_target_slots.push(0);

        workspace.reset_transfer_buffers(&prepared, &selection);

        assert!(matches!(
            workspace.post_actions[0],
            BeltPostAction::ResetProgress
        ));
        assert!(matches!(workspace.post_actions[1], BeltPostAction::None));
        assert!(matches!(workspace.post_actions[2], BeltPostAction::None));
        assert!(matches!(
            workspace.post_actions[3],
            BeltPostAction::ResetProgress
        ));
        assert!(workspace.target_free[0].is_nan());
        assert!(workspace.touched_target_slots.is_empty());
    }

    #[test]
    fn sparse_selection_recycles_its_mask_allocation() {
        let mut selected_group_indices = Vec::with_capacity(64);
        selected_group_indices.extend([0, 2]);
        let index_capacity = selected_group_indices.capacity();
        let mut selected_route_indices = Vec::with_capacity(32);
        selected_route_indices.extend([1, 4]);
        let route_capacity = selected_route_indices.capacity();
        let selection = ActiveSelection::Mask {
            selected_group_indices,
            selected_route_indices,
        };
        assert_eq!(selection.group_indices(3).collect::<Vec<_>>(), [0, 2]);
        assert_eq!(selection.route_indices(5).collect::<Vec<_>>(), [1, 4]);
        let mut index_scratch = Vec::new();
        let mut route_scratch = Vec::new();

        selection.recycle_into(&mut index_scratch, &mut route_scratch);

        assert_eq!(index_scratch, [0, 2]);
        assert_eq!(route_scratch, [1, 4]);
        assert_eq!(index_scratch.capacity(), index_capacity);
        assert_eq!(route_scratch.capacity(), route_capacity);
    }

    #[test]
    fn dense_selection_uses_flat_order_and_retains_sparse_scratch() {
        let selection = ActiveSelection::Dense {
            selected_group_indices: vec![0, 1, 2],
            selected_route_indices: vec![0, 1, 2],
        };
        assert!(selection.is_full_scan());
        assert_eq!(selection.selected_routes(17), 17);
        assert_eq!(selection.group_indices(4).collect::<Vec<_>>(), [0, 1, 2, 3]);

        let mut indices = Vec::new();
        let mut routes = Vec::new();
        selection.recycle_into(&mut indices, &mut routes);
        assert_eq!(indices, [0, 1, 2]);
        assert_eq!(routes, [0, 1, 2]);
        assert!(ActiveSelection::All.is_full_scan());
    }

    fn target_capacity_plan_fixture() -> PreparedRoutes {
        let route = |source_group: usize, target_slot: usize, belt_sort_rank: usize| Route {
            capacity: 6.0,
            source_index: compact_index(source_group, "test source index").unwrap(),
            target_index: compact_index(target_slot, "test target index").unwrap(),
            source_group: compact_index(source_group, "test source group").unwrap(),
            target_slot: compact_index(target_slot, "test target slot").unwrap(),
            belt_sort_rank: compact_index(belt_sort_rank, "test belt rank").unwrap(),
            target_port_index: None,
            priority: 1,
        };
        PreparedRoutes {
            routes: vec![
                route(0, 2, 0),
                route(0, 0, 1),
                route(1, 0, 0),
                route(1, 1, 1),
                route(2, 3, 0),
            ],
            groups: vec![
                PreparedGroup {
                    source_index: 0,
                    item_symbol: 0,
                    balanced_splitter: false,
                    always_awake: false,
                    route_indices: vec![0, 1].into_boxed_slice(),
                },
                PreparedGroup {
                    source_index: 1,
                    item_symbol: 0,
                    balanced_splitter: false,
                    always_awake: false,
                    route_indices: vec![2, 3].into_boxed_slice(),
                },
                PreparedGroup {
                    source_index: 2,
                    item_symbol: 0,
                    balanced_splitter: false,
                    always_awake: false,
                    route_indices: vec![4].into_boxed_slice(),
                },
            ],
            target_slot_count: 4,
            total_capacity: 30.0,
            group_by_key: Arc::new(HashMap::new()),
        }
    }

    fn target_capacity_runtime_groups(available: [f64; 3]) -> Vec<Group> {
        available
            .into_iter()
            .map(|available| Group {
                available,
                ..Group::default()
            })
            .collect()
    }

    #[test]
    fn target_capacity_plan_deduplicates_conflicts_and_keeps_stable_first_use_order() {
        let prepared = target_capacity_plan_fixture();
        let groups = target_capacity_runtime_groups([5.0, 7.0, 0.0]);
        let mut target_free = vec![f64::NAN; 4];
        let mut touched = Vec::new();
        let plan = build_transfer_target_capacity_plan(
            &prepared,
            &ActiveSelection::All,
            &groups,
            &mut target_free,
            &mut touched,
        )
        .unwrap();

        assert_eq!(
            plan.iter()
                .map(|entry| expand_compact_index(entry.route_index))
                .collect::<Vec<_>>(),
            [0, 1, 3]
        );
        assert_eq!(touched, [2, 0, 1]);
        assert!(target_free[0].is_infinite() && target_free[0].is_sign_negative());
        assert!(target_free[1].is_infinite() && target_free[1].is_sign_negative());
        assert!(target_free[2].is_infinite() && target_free[2].is_sign_negative());
        assert!(target_free[3].is_nan());
    }

    #[test]
    fn target_capacity_plan_respects_sparse_selection() {
        let prepared = target_capacity_plan_fixture();
        let groups = target_capacity_runtime_groups([5.0, 7.0, 9.0]);
        let selection = ActiveSelection::Mask {
            selected_group_indices: vec![1],
            selected_route_indices: vec![2, 3],
        };
        let mut target_free = vec![f64::NAN; 4];
        let mut touched = Vec::new();

        let plan = build_transfer_target_capacity_plan(
            &prepared,
            &selection,
            &groups,
            &mut target_free,
            &mut touched,
        )
        .unwrap();

        assert_eq!(
            plan.iter()
                .map(|entry| expand_compact_index(entry.route_index))
                .collect::<Vec<_>>(),
            [2, 3]
        );
        assert_eq!(touched, [0, 1]);
        assert!(target_free[2].is_nan() && target_free[3].is_nan());
    }

    #[test]
    fn target_capacity_plan_fails_closed_on_out_of_range_mod_topology() {
        let mut prepared = target_capacity_plan_fixture();
        prepared.groups[0].route_indices = vec![u32::MAX].into_boxed_slice();
        let groups = target_capacity_runtime_groups([5.0, 7.0, 9.0]);
        let mut target_free = vec![f64::NAN; 4];
        let mut touched = Vec::new();

        let error = build_transfer_target_capacity_plan(
            &prepared,
            &ActiveSelection::All,
            &groups,
            &mut target_free,
            &mut touched,
        )
        .unwrap_err();

        assert!(error.to_string().contains("outside the topology"));
        assert!(target_free.iter().all(|value| value.is_nan()));
        assert!(touched.is_empty());
    }

    #[test]
    fn reservation_target_capacity_plan_reuses_only_proven_stable_cached_slots() {
        let prepared = target_capacity_plan_fixture();
        let selection = ActiveSelection::All;
        let progress = [4.0, 4.0, 4.0, 4.0, 0.0];
        // Slots 0 and 2 were populated by the immediately preceding input
        // transfer. Route 1 deliberately models a shared-domain target whose
        // cached value must be refreshed; route 0 models an owned target slot.
        let mut target_free = vec![17.0, f64::NAN, 23.0, f64::NAN];
        let mut touched = vec![0, 2];
        let mut classified = Vec::new();

        let plan = build_reservation_target_capacity_plan(
            &prepared,
            &selection,
            &mut target_free,
            &mut touched,
            |route_index| Ok(progress[route_index]),
            |route_index| {
                classified.push(route_index);
                Ok(match route_index {
                    1 => ReservationTargetCapacityPolicy {
                        reuse_cached: false,
                    },
                    _ => ReservationTargetCapacityPolicy { reuse_cached: true },
                })
            },
        )
        .unwrap();

        assert_eq!(classified, [0, 1, 3]);
        assert_eq!(
            plan.iter()
                .map(|entry| expand_compact_index(entry.route_index))
                .collect::<Vec<_>>(),
            [1, 3]
        );
        assert_eq!(touched, [0, 2, 1]);
        assert!(target_free[0].is_infinite() && target_free[0].is_sign_negative());
        assert!(target_free[1].is_infinite() && target_free[1].is_sign_negative());
        assert_eq!(target_free[2].to_bits(), 23.0_f64.to_bits());
        assert!(target_free[3].is_nan());
    }

    fn target_capacity_resolver_fixture(component_count: usize) -> PreparedRoutes {
        let routes = (0..component_count)
            .map(|route_index| Route {
                capacity: 6.0,
                source_index: 0,
                target_index: 0,
                source_group: 0,
                target_slot: compact_index(route_index, "resolver target slot").unwrap(),
                belt_sort_rank: compact_index(route_index, "resolver belt rank").unwrap(),
                target_port_index: None,
                priority: 1,
            })
            .collect::<Vec<_>>();
        PreparedRoutes {
            routes,
            groups: Vec::new(),
            target_slot_count: compact_index(component_count, "resolver target count").unwrap(),
            total_capacity: component_count as f64 * 6.0,
            group_by_key: Arc::new(HashMap::new()),
        }
    }

    fn target_capacity_plan(component_count: usize) -> Vec<TargetCapacityPlanEntry> {
        (0..component_count)
            .map(|route_index| TargetCapacityPlanEntry {
                route_index: compact_index(route_index, "resolver plan route").unwrap(),
            })
            .collect()
    }

    fn resolver_capacity(route_index: usize) -> f64 {
        if route_index.is_multiple_of(257) {
            -0.0
        } else {
            f64::from(u32::try_from(route_index % 10_007).unwrap()) + 0.25
        }
    }

    #[test]
    fn target_capacity_resolution_matches_bitwise_at_one_two_four_and_eight_workers() {
        let component_count = crate::deterministic_runtime::PARALLEL_MIN_ITEMS + 257;
        let prepared = target_capacity_resolver_fixture(component_count);
        let plan = target_capacity_plan(component_count);
        let run = |workers| {
            let mut target_free = vec![f64::NEG_INFINITY; component_count];
            let mut serial_session = ();
            let diagnostics = resolve_target_capacity_plan_with_runtime(
                &prepared,
                &plan,
                &mut target_free,
                &mut serial_session,
                &DeterministicRuntime::for_test(workers),
                || (),
                |route_index, _| Ok(resolver_capacity(route_index)),
            )
            .unwrap();
            (
                diagnostics,
                target_free
                    .into_iter()
                    .map(f64::to_bits)
                    .collect::<Vec<_>>(),
            )
        };

        let expected = run(1);
        assert_eq!(expected.0.worker_count, 1);
        assert_eq!(expected.0.parallel_component_count, 0);
        assert_eq!(expected.0.serial_component_count, component_count);
        for workers in [2, 4, 8] {
            let actual = run(workers);
            assert_eq!(actual.0.worker_count, workers);
            assert_eq!(
                actual.0.component_count, expected.0.component_count,
                "worker limit {workers}"
            );
            assert_eq!(actual.0.parallel_component_count, component_count);
            assert_eq!(actual.0.serial_component_count, 0);
            assert_eq!(actual.1, expected.1, "worker limit {workers}");
        }
    }

    #[test]
    fn target_capacity_resolution_owns_one_private_session_per_fixed_chunk() {
        let component_count = crate::deterministic_runtime::PARALLEL_MIN_ITEMS + 2_117;
        let prepared = target_capacity_resolver_fixture(component_count);
        let plan = target_capacity_plan(component_count);
        let created_sessions = std::sync::atomic::AtomicUsize::new(0);
        let mut serial_session = 0_usize;
        let mut target_free = vec![f64::NEG_INFINITY; component_count];

        let diagnostics = resolve_target_capacity_plan_with_runtime(
            &prepared,
            &plan,
            &mut target_free,
            &mut serial_session,
            &DeterministicRuntime::for_test(8),
            || {
                created_sessions.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                0_usize
            },
            |route_index, private_session| {
                assert!(*private_session < TARGET_CAPACITY_ROWS_PER_CHUNK);
                *private_session += 1;
                Ok(resolver_capacity(route_index))
            },
        )
        .unwrap();

        assert_eq!(diagnostics.worker_count, 8);
        assert_eq!(
            created_sessions.load(std::sync::atomic::Ordering::Relaxed),
            component_count.div_ceil(TARGET_CAPACITY_ROWS_PER_CHUNK)
        );
        assert_eq!(serial_session, 0);
        assert_eq!(
            target_free
                .into_iter()
                .map(f64::to_bits)
                .collect::<Vec<_>>(),
            (0..component_count)
                .map(|route_index| resolver_capacity(route_index).to_bits())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn target_capacity_resolution_keeps_small_batches_off_the_rayon_pool() {
        let component_count = crate::deterministic_runtime::PARALLEL_MIN_ITEMS - 1;
        let prepared = target_capacity_resolver_fixture(component_count);
        let plan = target_capacity_plan(component_count);
        let observed_pool_worker = std::sync::atomic::AtomicBool::new(false);
        let mut target_free = vec![f64::NEG_INFINITY; component_count];
        let mut serial_session = ();

        let diagnostics = resolve_target_capacity_plan_with_runtime(
            &prepared,
            &plan,
            &mut target_free,
            &mut serial_session,
            &DeterministicRuntime::for_test(8),
            || (),
            |route_index, _| {
                if rayon::current_thread_index().is_some() {
                    observed_pool_worker.store(true, std::sync::atomic::Ordering::Relaxed);
                }
                Ok(resolver_capacity(route_index))
            },
        )
        .unwrap();

        assert_eq!(diagnostics.worker_count, 1);
        assert!(!observed_pool_worker.load(std::sync::atomic::Ordering::Relaxed));
    }

    #[test]
    fn target_capacity_resolution_reports_the_first_stable_error_after_workers_finish() {
        let component_count = crate::deterministic_runtime::PARALLEL_MIN_ITEMS + 1;
        let prepared = target_capacity_resolver_fixture(component_count);
        let plan = target_capacity_plan(component_count);
        let completed = std::sync::atomic::AtomicUsize::new(0);
        let source = "mod:保持/原检查点/Ω🚀".to_owned();
        let source_before = source.clone();
        let mut target_free = vec![f64::NEG_INFINITY; component_count];
        let mut serial_session = ();

        let error = resolve_target_capacity_plan_with_runtime(
            &prepared,
            &plan,
            &mut target_free,
            &mut serial_session,
            &DeterministicRuntime::for_test(8),
            || (),
            |route_index, _| {
                let _ = source.len();
                completed.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                if matches!(route_index, 17 | 4_096) {
                    Err(anyhow!("private capacity probe {route_index} failed"))
                } else {
                    Ok(resolver_capacity(route_index))
                }
            },
        )
        .unwrap_err();

        assert_eq!(error.to_string(), "private capacity probe 17 failed");
        assert_eq!(
            completed.load(std::sync::atomic::Ordering::Relaxed),
            component_count
        );
        assert_eq!(source, source_before);
        assert_eq!(target_free[16].to_bits(), resolver_capacity(16).to_bits());
        assert!(target_free[17].is_infinite() && target_free[17].is_sign_negative());
    }

    #[test]
    fn sparse_output_credits_preserve_missing_and_present_lookup() {
        let credits = OutputCredits {
            group_by_key: Arc::new(HashMap::from([((7, 11), 1)])),
            by_group: HashMap::from([(1, 42.0)]),
            active_source_items: vec![(7, 11)],
        };

        assert_eq!(credits.get(7, 11), 42.0);
        assert_eq!(credits.get(7, 12), 0.0);
        assert_eq!(credits.get(8, 11), 0.0);
    }

    #[test]
    fn persisted_belt_dimensions_keep_the_v47_missing_lane_default() {
        let missing_lane = json!({ "stackSize": 2 });
        let explicit_lane = json!({ "lanes": 3, "stackSize": 4 });

        assert_eq!(
            persisted_belt_dimensions(missing_lane.as_object().unwrap()),
            (1.0, 2.0)
        );
        assert_eq!(
            persisted_belt_dimensions(explicit_lane.as_object().unwrap()),
            (3.0, 4.0)
        );
    }

    #[test]
    fn belt_writeback_plan_keeps_sparse_and_parallel_boundaries_explicit() {
        let runtime = DeterministicRuntime::for_test(8);

        assert_eq!(
            belt_writeback_plan(&runtime, 12_288, 0),
            BeltWritebackPlan {
                dense: false,
                patch_count: 0,
                worker_count: 0,
            }
        );
        assert_eq!(
            belt_writeback_plan(&runtime, 12_288, 4_096),
            BeltWritebackPlan {
                dense: false,
                patch_count: 4_096,
                worker_count: 1,
            }
        );
        assert_eq!(
            belt_writeback_plan(&runtime, 12_288, 4_097),
            BeltWritebackPlan {
                dense: true,
                patch_count: 12_288,
                worker_count: 8,
            }
        );
        assert_eq!(
            belt_writeback_plan(&runtime, 4_095, 1_366),
            BeltWritebackPlan {
                dense: true,
                patch_count: 4_095,
                worker_count: 1,
            }
        );

        let serial = DeterministicRuntime::for_test(1);
        assert_eq!(belt_writeback_plan(&serial, 12_288, 4_097).worker_count, 1);
    }
}
