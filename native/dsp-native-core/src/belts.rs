use std::collections::HashMap;
use std::fmt::Write as _;
use std::mem::size_of;
use std::sync::Arc;

use anyhow::{Context, anyhow, bail};
use num_bigint::BigUint;
use serde::Serialize;
use serde_json::value::RawValue;
use serde_json::{Deserializer, Map, Number, Value};

use crate::deterministic_runtime::{DeterministicRuntime, runtime as deterministic_runtime};
use crate::state::{BeltCommitSource, BeltDynamicColumns, CoreState, ExactRowIds, RawRecord};

const EPSILON: f64 = 0.0001;

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
        runtime.into_patches(state).map(|(batch, _, _)| batch)
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
}

#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct BeltFlowAggregate {
    pub capacity: f64,
    pub flow: f64,
}

#[derive(Debug, Default)]
pub(crate) struct OutputCredits {
    group_by_key: Arc<HashMap<(u32, u32), u32>>,
    by_group: Vec<f64>,
}

impl OutputCredits {
    #[inline]
    fn get(&self, source_index: usize, item_symbol: u32) -> f64 {
        let Ok(source_index) = u32::try_from(source_index) else {
            return 0.0;
        };
        self.group_by_key
            .get(&(source_index, item_symbol))
            .and_then(|&group_index| self.by_group.get(expand_compact_index(group_index)))
            .copied()
            .unwrap_or(0.0)
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BeltSchedulerDiagnostics {
    pub route_count: usize,
    pub group_count: usize,
    pub active_queue_enabled: bool,
    pub transfer_passes: u64,
    pub reservation_passes: u64,
    pub full_scan_passes: u64,
    pub transfer_route_checks: u64,
    pub reservation_route_checks: u64,
    pub stable_routes_skipped: u64,
    pub wake_count: u64,
    pub sleep_count: u64,
    pub changed_belt_records: usize,
    pub write_back_patch_records: usize,
    pub write_back_workers: usize,
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
    // Indexed by the immutable belt row. NaN means that the JS reservation
    // pass did not cap this belt; using IDs here allocated and hashed more than
    // 150,000 strings every simulated second on the player stress save.
    pub allowance_by_belt: Vec<f64>,
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
    source: Option<BeltCommitSource>,
    progress: Vec<f64>,
    total_transferred: Vec<f64>,
    congestion: Vec<f64>,
    last_flow: Vec<f64>,
    total_dirty: Vec<bool>,
    belt_capacity: f64,
    // Runtime-only source/item wake state. A group may sleep only when its
    // source has no cargo and every persisted belt signal is exactly idle.
    // Production and logistics are checked again at every output boundary, so
    // a sleeping group is re-admitted in the same deterministic step in which
    // cargo becomes available.
    active_groups: Vec<bool>,
    active_queue_enabled: bool,
    diagnostics: BeltSchedulerDiagnostics,
    workspace: BeltWorkspace,
}

impl BeltRuntime {
    fn empty(belt_count: usize, prepared_routes: &PreparedRoutes) -> Self {
        Self {
            source: None,
            progress: Vec::with_capacity(belt_count),
            total_transferred: Vec::with_capacity(belt_count),
            congestion: Vec::with_capacity(belt_count),
            last_flow: Vec::with_capacity(belt_count),
            total_dirty: vec![false; belt_count],
            belt_capacity: prepared_routes.total_capacity,
            active_groups: vec![false; prepared_routes.groups.len()],
            active_queue_enabled: false,
            diagnostics: BeltSchedulerDiagnostics {
                route_count: prepared_routes.routes.len(),
                group_count: prepared_routes.groups.len(),
                ..BeltSchedulerDiagnostics::default()
            },
            workspace: BeltWorkspace::new(
                belt_count,
                prepared_routes.groups.len(),
                expand_compact_index(prepared_routes.target_slot_count),
            ),
        }
    }

    fn finish_activity(
        mut self,
        state: &CoreState,
        entities: &[Value],
        prepared_routes: &PreparedRoutes,
    ) -> anyhow::Result<Self> {
        if self.progress.len() != prepared_routes.routes.len() {
            bail!("native belt runtime topology changed");
        }
        let mut initially_dormant_routes = 0_usize;
        for (group_index, group) in prepared_routes.groups.iter().enumerate() {
            let item_id = state
                .symbols
                .resolve(group.item_symbol)
                .ok_or_else(|| anyhow!("native prepared belt item is missing"))?;
            let source = entities[expand_compact_index(group.source_index)]
                .as_object()
                .ok_or_else(|| anyhow!("native belt source is not an object"))?;
            let has_source_output = output_amount(source, item_id) > EPSILON;
            let has_runtime_signal = group.route_indices.iter().copied().any(|route_index| {
                let belt_index = expand_compact_index(route_index);
                self.progress[belt_index].abs() > EPSILON
                    || self.last_flow[belt_index].abs() > EPSILON
                    || self.congestion[belt_index].abs() > EPSILON
            });
            self.active_groups[group_index] = has_source_output
                || has_runtime_signal
                || source_may_produce_during_step(state, source, item_id);
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
        prepared_routes: &PreparedRoutes,
    ) -> anyhow::Result<Self> {
        let belt_count = state.validate_belt_runtime_topology()?;
        let mut runtime = Self::empty(belt_count, prepared_routes);
        runtime.source = Some(state.belt_commit_source());
        // These four flat copies replace one serde_json parse and object-map
        // lookup for every belt at the start of every exact advance.
        runtime.progress.clone_from(&state.belt_dynamics.progress);
        runtime
            .total_transferred
            .clone_from(&state.belt_dynamics.total_transferred);
        runtime
            .congestion
            .clone_from(&state.belt_dynamics.congestion);
        runtime.last_flow.clone_from(&state.belt_dynamics.last_flow);
        runtime.finish_activity(state, entities, prepared_routes)
    }

    #[cfg(test)]
    pub(crate) fn from_dynamics_for_test(
        state: &CoreState,
        dynamics: BeltDynamicColumns,
    ) -> anyhow::Result<Self> {
        let belt_count = state.validate_belt_runtime_topology()?;
        dynamics.validate(belt_count)?;
        let total_dirty = dynamics
            .total_transferred
            .iter()
            .zip(&state.belt_dynamics.total_transferred)
            .map(|(next, previous)| next.to_bits() != previous.to_bits())
            .collect::<Vec<_>>();
        Ok(Self {
            source: Some(state.belt_commit_source()),
            progress: dynamics.progress,
            total_transferred: dynamics.total_transferred,
            congestion: dynamics.congestion,
            last_flow: dynamics.last_flow,
            total_dirty,
            belt_capacity: 0.0,
            active_groups: Vec::new(),
            active_queue_enabled: false,
            diagnostics: BeltSchedulerDiagnostics::default(),
            workspace: BeltWorkspace::new(belt_count, 0, 0),
        })
    }

    #[cfg(test)]
    pub(crate) fn clear_total_dirty_for_test(&mut self, index: usize) {
        self.total_dirty[index] = false;
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
    ) -> anyhow::Result<(BeltCommitBatch, BeltFlowAggregate, BeltSchedulerDiagnostics)> {
        self.into_patches_with_runtime(state, deterministic_runtime())
    }

    fn into_patches_with_runtime(
        mut self,
        state: &CoreState,
        runtime: &DeterministicRuntime,
    ) -> anyhow::Result<(BeltCommitBatch, BeltFlowAggregate, BeltSchedulerDiagnostics)> {
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
        let mut changed_count = 0_usize;
        let mut number_mask = state.belt_dynamics.number_mask.clone();
        let mut flow = 0.0;
        for (index, persisted_mask) in number_mask.iter_mut().enumerate() {
            if !self.total_dirty[index]
                && self.total_transferred[index].to_bits()
                    != state.belt_dynamics.total_transferred[index].to_bits()
            {
                bail!("native belt transfer total changed without a dirty marker");
            }
            flow += self.last_flow[index].max(0.0);
            let changed = self.record_needs_write(&state.belt_dynamics, index);
            changed_count += usize::from(changed);
            if changed {
                *persisted_mask |= (1 << BeltDynamicColumns::PROGRESS)
                    | (1 << BeltDynamicColumns::LAST_FLOW)
                    | (1 << BeltDynamicColumns::CONGESTION);
                if self.total_dirty[index] {
                    *persisted_mask |= 1 << BeltDynamicColumns::TOTAL_TRANSFERRED;
                }
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
            let mut patches = Vec::with_capacity(plan.patch_count);
            for index in 0..belt_count {
                if self.record_needs_write(&state.belt_dynamics, index) {
                    patches.push(self.raw_patch_for_index(state, index)?);
                }
            }
            patches
        };
        if !self.belt_capacity.is_finite() || !flow.is_finite() {
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
        let dynamics = BeltDynamicColumns {
            progress: self.progress,
            total_transferred: self.total_transferred,
            congestion: self.congestion,
            last_flow: self.last_flow,
            number_mask,
        };
        dynamics.validate(belt_count)?;
        let dynamics = (changed_count != 0).then_some(dynamics);
        let source = self
            .source
            .take()
            .ok_or_else(|| anyhow!("native belt runtime source proof is missing"))?;
        let batch = BeltCommitBatch::seal(source, patches, dynamics);
        Ok((
            batch,
            BeltFlowAggregate {
                capacity: self.belt_capacity,
                flow,
            },
            self.diagnostics,
        ))
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

#[derive(Debug)]
struct BeltWorkspace {
    post_actions: Vec<BeltPostAction>,
    target_free: Vec<f64>,
    touched_target_slots: Vec<u32>,
    groups: Vec<Group>,
    usable_candidate_indices: Vec<usize>,
    active_candidate_indices: Vec<usize>,
    selected_group_indices: Vec<u32>,
    selected_route_indices: Vec<u32>,
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
        }
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
    }
}

fn advance_belt_clocks(
    runtime: &mut BeltRuntime,
    prepared_routes: &PreparedRoutes,
    selection: &ActiveSelection,
    seconds: f64,
    belt_limit: f64,
) -> anyhow::Result<()> {
    if seconds <= 0.0 || runtime.progress.is_empty() {
        return Ok(());
    }
    let flow_decay = 0.8_f64.powf(seconds);
    let congestion_decay = 0.85_f64.powf(seconds);
    let mut advance_route = |belt_index: usize| {
        let route = &prepared_routes.routes[belt_index];
        let index = belt_index;
        runtime.last_flow[index] = rounded(runtime.last_flow[index] * flow_decay, 3);
        runtime.congestion[index] = rounded(runtime.congestion[index] * congestion_decay, 3);
        let current = runtime.progress[index].max(0.0);
        let progress = if current > belt_limit {
            current
        } else {
            (current + route.capacity * seconds).min(belt_limit)
        };
        runtime.progress[index] = rounded(progress, 4);
    };
    match selection {
        ActiveSelection::All | ActiveSelection::Dense { .. } => {
            for belt_index in 0..prepared_routes.routes.len() {
                advance_route(belt_index);
            }
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
                    advance_route(expand_compact_index(route_index));
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
    let mut apply_route = |belt_index: usize| {
        let route = &prepared_routes.routes[belt_index];
        let index = belt_index;
        match actions[index] {
            BeltPostAction::None => {}
            BeltPostAction::ResetProgress => progress[index] = 0.0,
            BeltPostAction::Flow {
                available,
                free,
                moved,
            } => {
                progress[index] =
                    if !defer_source_depletion_reset && available <= 0.0 || free <= 0.0 {
                        0.0
                    } else {
                        rounded((progress[index] - moved).max(0.0), 4)
                    };
                if moved > 0.0 {
                    if flow_window_seconds > 0.0 {
                        let prior = if seconds > 0.0 { 0.0 } else { last_flow[index] };
                        last_flow[index] =
                            rounded(route.capacity.min(prior + moved / flow_window_seconds), 3);
                    }
                    total_transferred[index] = (total_transferred[index] + moved).floor();
                    total_dirty[index] = true;
                }
                let load = if route.capacity > EPSILON {
                    last_flow[index] / route.capacity
                } else {
                    0.0
                };
                congestion[index] = rounded(
                    1.0_f64.min(load.max(if available > 0.0 && free <= 0.0 {
                        1.0
                    } else {
                        0.0
                    })),
                    3,
                );
            }
        }
    };
    match selection {
        ActiveSelection::All | ActiveSelection::Dense { .. } => {
            for belt_index in 0..prepared_routes.routes.len() {
                apply_route(belt_index);
            }
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
                    apply_route(expand_compact_index(route_index));
                }
            }
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn select_active_groups(
    state: &CoreState,
    entities: &[Value],
    runtime: &BeltRuntime,
    prepared_routes: &PreparedRoutes,
    reservation: Option<&BeltStepReservation>,
    seconds: f64,
    mut selected_group_indices: Vec<u32>,
    mut selected_route_indices: Vec<u32>,
) -> anyhow::Result<ActiveSelection> {
    if !runtime.active_queue_enabled {
        return Ok(ActiveSelection::All);
    }
    selected_group_indices.clear();
    selected_route_indices.clear();
    let mut selected_routes = 0_u64;
    for (group_index, group) in prepared_routes.groups.iter().enumerate() {
        let item_id = state
            .symbols
            .resolve(group.item_symbol)
            .ok_or_else(|| anyhow!("native prepared belt item is missing"))?;
        let source = entities[expand_compact_index(group.source_index)]
            .as_object()
            .ok_or_else(|| anyhow!("native belt source is not an object"))?;
        let has_allowance = reservation.is_some_and(|reservation| {
            reservation
                .output_credits
                .by_group
                .get(group_index)
                .is_some_and(|value| value.is_finite() && *value >= 1.0)
        });
        let selected = runtime.active_groups[group_index]
            || output_amount(source, item_id) > EPSILON
            || seconds > EPSILON && source_may_produce_during_step(state, source, item_id)
            || has_allowance;
        if selected {
            selected_routes += group.route_indices.len() as u64;
            selected_group_indices.push(compact_index(group_index, "active group index")?);
            selected_route_indices.extend_from_slice(&group.route_indices);
        }
    }
    let route_count = prepared_routes.routes.len() as u64;
    if selected_routes.saturating_mul(4) >= route_count.saturating_mul(3) {
        // Once at least 75% of routes are awake, scanning a dense flat column
        // is cheaper than repeatedly chasing per-group slices. Keep both
        // scratch allocations attached to the selection so the next sparse
        // pass can reuse them without rebuilding a factory-sized mask.
        Ok(ActiveSelection::Dense {
            selected_group_indices,
            selected_route_indices,
        })
    } else {
        // Reservation capacity is shared by target slot and historically
        // consumed in persisted belt-row order. Group slices are sorted for
        // source fairness, not globally by row, so recover the old stable
        // order before the sparse reservation pass skips dormant routes.
        selected_route_indices.sort_unstable();
        Ok(ActiveSelection::Mask {
            selected_group_indices,
            selected_route_indices,
        })
    }
}

fn refresh_active_groups(
    runtime: &mut BeltRuntime,
    prepared_routes: &PreparedRoutes,
    selection: &ActiveSelection,
) {
    if !runtime.active_queue_enabled {
        return;
    }
    let mut refresh_group = |group_index: usize| {
        let group = &prepared_routes.groups[group_index];
        let previous = runtime.active_groups[group_index];
        let next = group.route_indices.iter().copied().any(|route_index| {
            let belt_index = expand_compact_index(route_index);
            runtime.progress[belt_index].abs() > EPSILON
                || runtime.last_flow[belt_index].abs() > EPSILON
                || runtime.congestion[belt_index].abs() > EPSILON
        });
        runtime.active_groups[group_index] = next;
        if next && !previous {
            runtime.diagnostics.wake_count = runtime.diagnostics.wake_count.saturating_add(1);
        } else if previous && !next {
            runtime.diagnostics.sleep_count = runtime.diagnostics.sleep_count.saturating_add(1);
        }
    };
    match selection {
        ActiveSelection::All | ActiveSelection::Dense { .. } => {
            for group_index in 0..prepared_routes.groups.len() {
                refresh_group(group_index);
            }
        }
        ActiveSelection::Mask {
            selected_group_indices,
            ..
        } => {
            for group_index in selected_group_indices.iter().copied() {
                refresh_group(expand_compact_index(group_index));
            }
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

fn source_may_produce_during_step(
    state: &CoreState,
    source: &Map<String, Value>,
    item_id: &str,
) -> bool {
    if string_at(source, "kind") == Some("vein") {
        return string_at(source, "resourceId") == Some(item_id);
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
        Some("orbital_collector" | "energy_exchanger")
    ) || string_at(source, "kind") == Some("station")
        && string_at(source, "quantumMode") == Some("quantum")
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

#[allow(clippy::too_many_arguments)]
pub(crate) fn transfer(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entities: &mut [Value],
    belt_runtime: &mut BeltRuntime,
    prepared_routes: &PreparedRoutes,
    seconds: f64,
    defer_source_depletion_reset: bool,
    reservation: Option<&BeltStepReservation>,
    flow_window_seconds: f64,
) -> anyhow::Result<()> {
    if belt_runtime.progress.is_empty() {
        return Ok(());
    }
    let routes = &prepared_routes.routes;
    let quantum_bandwidth = crate::quantum_logistics::runtime_bandwidth(base, entities);
    let mut quantum_session = None;
    let belt_limit = normalized_buffer_limit(
        base.get("settings")
            .and_then(Value::as_object)
            .and_then(|settings| settings.get("beltBufferLimit")),
    );
    let selected_group_index_scratch = if belt_runtime.active_queue_enabled {
        std::mem::take(&mut belt_runtime.workspace.selected_group_indices)
    } else {
        Vec::new()
    };
    let selected_route_index_scratch = if belt_runtime.active_queue_enabled {
        std::mem::take(&mut belt_runtime.workspace.selected_route_indices)
    } else {
        Vec::new()
    };
    let selection = select_active_groups(
        state,
        entities,
        belt_runtime,
        prepared_routes,
        reservation,
        seconds,
        selected_group_index_scratch,
        selected_route_index_scratch,
    )?;
    belt_runtime.record_selection(prepared_routes, &selection, false);
    advance_belt_clocks(
        belt_runtime,
        prepared_routes,
        &selection,
        seconds,
        belt_limit,
    )?;
    let progress = &belt_runtime.progress;
    belt_runtime
        .workspace
        .reset_transfer_buffers(prepared_routes, &selection);
    let BeltWorkspace {
        post_actions,
        target_free,
        touched_target_slots,
        groups,
        usable_candidate_indices,
        active_candidate_indices,
        ..
    } = &mut belt_runtime.workspace;
    debug_assert_eq!(groups.len(), prepared_routes.groups.len());
    for group_index in selection.group_indices(prepared_routes.groups.len()) {
        let group = &mut groups[group_index];
        let prepared_group = &prepared_routes.groups[group_index];
        let item_id = state
            .symbols
            .resolve(prepared_group.item_symbol)
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
            let target = entities[route.target_index()]
                .as_object()
                .ok_or_else(|| anyhow!("native belt target is not an object"))?;
            let item_id = state
                .symbols
                .resolve(prepared_routes.groups[index].item_symbol)
                .ok_or_else(|| anyhow!("native prepared belt item is missing"))?;
            let target_slot = route.target_slot();
            if target_free[target_slot].is_nan() {
                let free = target_capacity(
                    state,
                    base,
                    &mut quantum_session,
                    entities,
                    target,
                    item_id,
                    route.target_port_index,
                )?
                .floor()
                .max(0.0);
                target_free[target_slot] = free;
                touched_target_slots.push(compact_index(target_slot, "transfer target slot")?);
            }
            if target_free[target_slot] < 1.0 {
                post_actions[route_index] = BeltPostAction::ResetProgress;
                continue;
            }
            let cap = reservation
                .and_then(|reservation| reservation.allowance_by_belt.get(route_index).copied())
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
                target_free[target_slot] -= moved;
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
        let priorities: &[u8] = if group.candidates.len() == 1 || prepared_group.balanced_splitter {
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
                    target_free[target_slot] -= moved;
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
                active_candidate_indices.extend(usable_candidate_indices.iter().copied().filter(
                    |&index| {
                        let route = &routes[group.candidates[index].route_index];
                        group.candidates[index].allowance > 0.0
                            && target_free[route.target_slot()] > 0.0
                    },
                ));
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
                    let index =
                        active_candidate_indices[(start + offset) % active_candidate_indices.len()];
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
                    target_free[target_slot] -= moved;
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
    apply_belt_post_actions(
        belt_runtime,
        prepared_routes,
        &selection,
        seconds,
        defer_source_depletion_reset,
        flow_window_seconds,
    )?;
    crate::quantum_logistics::finish_supply_deposit_session(base, quantum_session)?;
    refresh_active_groups(belt_runtime, prepared_routes, &selection);
    selection.recycle_into(
        &mut belt_runtime.workspace.selected_group_indices,
        &mut belt_runtime.workspace.selected_route_indices,
    );
    Ok(())
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
    let mut result = BeltStepReservation {
        allowance_by_belt: vec![f64::NAN; belt_runtime.progress.len()],
        output_credits: OutputCredits {
            group_by_key: Arc::clone(&prepared_routes.group_by_key),
            by_group: vec![0.0; prepared_routes.groups.len()],
        },
    };
    let mut quantum_session = None;
    belt_runtime.workspace.reset_target_free();
    let selected_group_index_scratch = if belt_runtime.active_queue_enabled {
        std::mem::take(&mut belt_runtime.workspace.selected_group_indices)
    } else {
        Vec::new()
    };
    let selected_route_index_scratch = if belt_runtime.active_queue_enabled {
        std::mem::take(&mut belt_runtime.workspace.selected_route_indices)
    } else {
        Vec::new()
    };
    let selection = select_active_groups(
        state,
        entities,
        belt_runtime,
        prepared_routes,
        None,
        0.0,
        selected_group_index_scratch,
        selected_route_index_scratch,
    )?;
    belt_runtime.record_selection(prepared_routes, &selection, true);
    let progress = &belt_runtime.progress;
    let target_free = &mut belt_runtime.workspace.target_free;
    let touched_target_slots = &mut belt_runtime.workspace.touched_target_slots;
    for belt_index in selection.route_indices(routes.len()) {
        let route = &routes[belt_index];
        let source_group = route.source_group();
        let allowance = (progress[belt_index] + EPSILON).floor().max(0.0);
        if allowance < 1.0 {
            continue;
        }
        let target = entities[route.target_index()]
            .as_object()
            .ok_or_else(|| anyhow!("native belt target is not an object"))?;
        let prepared_group = &prepared_routes.groups[source_group];
        let item_id = state
            .symbols
            .resolve(prepared_group.item_symbol)
            .ok_or_else(|| anyhow!("native prepared belt item is missing"))?;
        let target_slot = route.target_slot();
        if target_free[target_slot].is_nan() {
            let free = target_capacity(
                state,
                base,
                &mut quantum_session,
                entities,
                target,
                item_id,
                route.target_port_index,
            )?
            .floor()
            .max(0.0);
            target_free[target_slot] = free;
            touched_target_slots.push(compact_index(target_slot, "reservation target slot")?);
        }
        let free = target_free[target_slot];
        let reserved = allowance.min(free.floor().max(0.0));
        if reserved < 1.0 {
            continue;
        }
        result.allowance_by_belt[belt_index] = reserved;
        target_free[target_slot] -= reserved;
        let credit = &mut result.output_credits.by_group[source_group];
        *credit = (*credit + reserved).min(belt_limit);
    }
    selection.recycle_into(
        &mut belt_runtime.workspace.selected_group_indices,
        &mut belt_runtime.workspace.selected_route_indices,
    );
    Ok(result)
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
    fn persisted_signal_bits_match_legacy_missing_and_negative_zero_rules() {
        let routes = empty_prepared_routes();
        let mut runtime = BeltRuntime::empty(3, &routes);
        let mut persisted = BeltDynamicColumns::default();
        for record in [
            json!({"progress":-0.0,"totalTransferred":7,"congestion":0,"lastFlow":0}),
            json!({"totalTransferred":7,"congestion":0,"lastFlow":0}),
            json!({"progress":0,"congestion":0,"lastFlow":0}),
        ] {
            persisted.push_from_object(record.as_object().unwrap());
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
                    route_indices: vec![0, 3].into_boxed_slice(),
                },
                PreparedGroup {
                    source_index: 1,
                    item_symbol: 0,
                    balanced_splitter: false,
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

    #[test]
    fn dense_output_credits_preserve_missing_and_present_lookup() {
        let credits = OutputCredits {
            group_by_key: Arc::new(HashMap::from([((7, 11), 1)])),
            by_group: vec![0.0, 42.0],
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
