use anyhow::{bail, ensure};
use serde::Serialize;

/// Runtime-only domains written by one deterministic factory candidate.
///
/// This is deliberately not a persisted bitfield. It is the closed manifest
/// shared by active selectors, statistics and diagnostics so a new writer
/// cannot silently update an entity without waking every dependent runtime.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub(crate) enum FactoryWriterDomain {
    Inventory = 0,
    Belt = 1,
    Logistics = 2,
    Route = 3,
    Quantum = 4,
    Production = 5,
    Power = 6,
    Research = 7,
    Dyson = 8,
    Construction = 9,
    Topology = 10,
}

impl FactoryWriterDomain {
    pub(crate) const COUNT: usize = 11;

    pub(crate) const ALL: [Self; Self::COUNT] = [
        Self::Inventory,
        Self::Belt,
        Self::Logistics,
        Self::Route,
        Self::Quantum,
        Self::Production,
        Self::Power,
        Self::Research,
        Self::Dyson,
        Self::Construction,
        Self::Topology,
    ];

    pub(crate) const fn index(self) -> usize {
        self as usize
    }

    pub(crate) const fn bit(self) -> u16 {
        1_u16 << self.index()
    }

    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Inventory => "inventory",
            Self::Belt => "belt",
            Self::Logistics => "logistics",
            Self::Route => "route",
            Self::Quantum => "quantum",
            Self::Production => "production",
            Self::Power => "power",
            Self::Research => "research",
            Self::Dyson => "dyson",
            Self::Construction => "construction",
            Self::Topology => "topology",
        }
    }
}

/// Candidate-local writer collection. Rows may arrive in arbitrary worker or
/// stage order; `seal` and `snapshot` normalize them into consumable manifests.
#[derive(Debug, Clone)]
pub(crate) struct FactoryWriterEvents {
    source_revision: u64,
    entity_count: usize,
    rows_by_domain: [Vec<usize>; FactoryWriterDomain::COUNT],
    domain_mask: u16,
    submitted_rows: usize,
    topology_changed: bool,
}

impl FactoryWriterEvents {
    pub(crate) fn new(source_revision: u64, entity_count: usize) -> Self {
        Self {
            source_revision,
            entity_count,
            rows_by_domain: std::array::from_fn(|_| Vec::new()),
            domain_mask: 0,
            submitted_rows: 0,
            topology_changed: false,
        }
    }

    pub(crate) fn record_global(&mut self, domain: FactoryWriterDomain) {
        self.domain_mask |= domain.bit();
        self.topology_changed |= domain == FactoryWriterDomain::Topology;
    }

    pub(crate) fn record_rows(
        &mut self,
        domain: FactoryWriterDomain,
        rows: &[usize],
    ) -> anyhow::Result<()> {
        self.record_global(domain);
        if let Some(&row) = rows.iter().find(|&&row| row >= self.entity_count) {
            bail!(
                "factory writer event row {row} exceeds entity count {}",
                self.entity_count
            );
        }
        self.submitted_rows = self.submitted_rows.saturating_add(rows.len());
        self.rows_by_domain[domain.index()].extend_from_slice(rows);
        Ok(())
    }

    pub(crate) fn record_topology_change(&mut self) {
        self.record_global(FactoryWriterDomain::Topology);
    }

    pub(crate) fn merge(&mut self, sealed: &SealedFactoryWriterEvents) -> anyhow::Result<()> {
        ensure!(
            sealed.source_revision() == self.source_revision
                && sealed.entity_count() == self.entity_count,
            "factory writer event lineage changed while merging a candidate"
        );
        self.domain_mask |= sealed.domain_mask;
        self.topology_changed |= sealed.topology_changed();
        self.submitted_rows = self.submitted_rows.saturating_add(sealed.submitted_rows());
        for domain in FactoryWriterDomain::ALL {
            self.rows_by_domain[domain.index()]
                .extend_from_slice(&sealed.rows_by_domain[domain.index()]);
        }
        Ok(())
    }

    pub(crate) fn all_rows(&self) -> Vec<usize> {
        let mut rows = self
            .rows_by_domain
            .iter()
            .flatten()
            .copied()
            .collect::<Vec<_>>();
        rows.sort_unstable();
        rows.dedup();
        rows
    }

    fn compact_rows(&mut self) {
        for rows in &mut self.rows_by_domain {
            rows.sort_unstable();
            rows.dedup();
        }
    }

    /// Snapshot cumulative writers at an internal Exact boundary without
    /// retaining another copy of every preceding second's duplicate rows.
    /// The submitted count still includes every event; consumers already use
    /// the sorted unique domain rows produced by `seal`.
    pub(crate) fn snapshot(&mut self) -> SealedFactoryWriterEvents {
        self.compact_rows();
        SealedFactoryWriterEvents {
            source_revision: self.source_revision,
            entity_count: self.entity_count,
            rows_by_domain: self.rows_by_domain.clone(),
            domain_mask: self.domain_mask,
            submitted_rows: self.submitted_rows,
            topology_changed: self.topology_changed,
        }
    }

    pub(crate) fn seal(mut self) -> SealedFactoryWriterEvents {
        self.compact_rows();
        SealedFactoryWriterEvents {
            source_revision: self.source_revision,
            entity_count: self.entity_count,
            rows_by_domain: self.rows_by_domain,
            domain_mask: self.domain_mask,
            submitted_rows: self.submitted_rows,
            topology_changed: self.topology_changed,
        }
    }
}

/// Stable, validated writer manifest for a complete stage or advance.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SealedFactoryWriterEvents {
    source_revision: u64,
    entity_count: usize,
    rows_by_domain: [Vec<usize>; FactoryWriterDomain::COUNT],
    domain_mask: u16,
    submitted_rows: usize,
    topology_changed: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FactoryStageScanDiagnostics {
    pub invocations: u64,
    pub selected_rows: u64,
    pub total_candidate_rows: u64,
    pub stable_rows_skipped: u64,
    pub dense_fallbacks: u64,
    pub directory_fallbacks: u64,
    pub full_scans: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FactoryStageExecutionDiagnostics {
    pub stage: String,
    #[serde(flatten)]
    pub scan: FactoryStageScanDiagnostics,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub(crate) enum FactoryScanStage {
    LogisticsBuffer = 0,
    MaterialDelivery = 1,
    OrdinaryProduction = 2,
    PlanetMetrics = 3,
    PowerProbe = 4,
    Quantum = 5,
    Construction = 6,
    LocalDispatch = 7,
    InterstellarDispatch = 8,
    WarperRefill = 9,
    LocalCongestion = 10,
    InterstellarCongestion = 11,
    StationTransition = 12,
    Belt = 13,
}

impl FactoryScanStage {
    const COUNT: usize = 14;
    const ALL: [Self; Self::COUNT] = [
        Self::LogisticsBuffer,
        Self::MaterialDelivery,
        Self::OrdinaryProduction,
        Self::PlanetMetrics,
        Self::PowerProbe,
        Self::Quantum,
        Self::Construction,
        Self::LocalDispatch,
        Self::InterstellarDispatch,
        Self::WarperRefill,
        Self::LocalCongestion,
        Self::InterstellarCongestion,
        Self::StationTransition,
        Self::Belt,
    ];

    const fn index(self) -> usize {
        self as usize
    }

    const fn as_str(self) -> &'static str {
        match self {
            Self::LogisticsBuffer => "logistics-buffer",
            Self::MaterialDelivery => "material-delivery",
            Self::OrdinaryProduction => "ordinary-production",
            Self::PlanetMetrics => "planet-metrics",
            Self::PowerProbe => "power-probe",
            Self::Quantum => "quantum",
            Self::Construction => "construction",
            Self::LocalDispatch => "local-dispatch",
            Self::InterstellarDispatch => "interstellar-dispatch",
            Self::WarperRefill => "warper-refill",
            Self::LocalCongestion => "local-congestion",
            Self::InterstellarCongestion => "interstellar-congestion",
            Self::StationTransition => "station-transition",
            Self::Belt => "belt",
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct FactoryExecutionDiagnosticsBuilder {
    source_revision: u64,
    simulation_seconds: f64,
    steps: u64,
    worker_limit: usize,
    observed_worker_count: usize,
    parallel_prepare_stages: u64,
    serial_prepare_stages: u64,
    stages: [FactoryStageScanDiagnostics; FactoryScanStage::COUNT],
}

impl FactoryExecutionDiagnosticsBuilder {
    pub(crate) fn new(
        source_revision: u64,
        worker_limit: usize,
        observed_worker_count: usize,
    ) -> Self {
        Self {
            source_revision,
            simulation_seconds: 0.0,
            steps: 0,
            worker_limit,
            observed_worker_count,
            parallel_prepare_stages: 0,
            serial_prepare_stages: 0,
            stages: [FactoryStageScanDiagnostics::default(); FactoryScanStage::COUNT],
        }
    }

    pub(crate) fn begin_step(&mut self, seconds: f64) {
        self.steps = self.steps.saturating_add(1);
        self.simulation_seconds += seconds;
    }

    pub(crate) fn observe_prepare(&mut self, parallel: bool) {
        if parallel {
            self.parallel_prepare_stages = self.parallel_prepare_stages.saturating_add(1);
        } else {
            self.serial_prepare_stages = self.serial_prepare_stages.saturating_add(1);
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn observe(
        &mut self,
        stage: FactoryScanStage,
        selected_rows: usize,
        total_candidate_rows: usize,
        stable_rows_skipped: usize,
        dense_fallback: bool,
        directory_fallback: bool,
        full_scan: bool,
    ) {
        let target = &mut self.stages[stage.index()];
        target.invocations = target.invocations.saturating_add(1);
        target.selected_rows = target.selected_rows.saturating_add(selected_rows as u64);
        target.total_candidate_rows = target
            .total_candidate_rows
            .saturating_add(total_candidate_rows as u64);
        target.stable_rows_skipped = target
            .stable_rows_skipped
            .saturating_add(stable_rows_skipped as u64);
        target.dense_fallbacks = target
            .dense_fallbacks
            .saturating_add(u64::from(dense_fallback));
        target.directory_fallbacks = target
            .directory_fallbacks
            .saturating_add(u64::from(directory_fallback));
        target.full_scans = target.full_scans.saturating_add(u64::from(full_scan));
    }

    pub(crate) fn finish(
        self,
        result_revision: u64,
        writer_events: &SealedFactoryWriterEvents,
    ) -> FactoryExecutionDiagnostics {
        let stage_scans = FactoryScanStage::ALL
            .into_iter()
            .filter_map(|stage| {
                let value = self.stages[stage.index()];
                (value.invocations != 0).then(|| FactoryStageExecutionDiagnostics {
                    stage: stage.as_str().to_owned(),
                    scan: value,
                })
            })
            .collect();
        FactoryExecutionDiagnostics {
            source_revision: self.source_revision,
            result_revision,
            simulation_seconds: self.simulation_seconds,
            steps: self.steps,
            entity_count: writer_events.entity_count(),
            writer_submitted_rows: writer_events.submitted_rows(),
            writer_unique_domain_rows: writer_events.unique_domain_rows(),
            writer_unique_rows: writer_events.all_rows().len(),
            writer_domains: writer_events
                .domain_names()
                .into_iter()
                .map(str::to_owned)
                .collect(),
            topology_changed: writer_events.topology_changed(),
            worker_limit: self.worker_limit,
            observed_worker_count: self.observed_worker_count,
            parallel_prepare_stages: self.parallel_prepare_stages,
            serial_prepare_stages: self.serial_prepare_stages,
            stage_scans,
        }
    }
}

/// Last committed exact-factory execution evidence. This value is disposable,
/// bounded and excluded from GameState/checkpoint/canonical bytes.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FactoryExecutionDiagnostics {
    pub source_revision: u64,
    pub result_revision: u64,
    pub simulation_seconds: f64,
    pub steps: u64,
    pub entity_count: usize,
    pub writer_submitted_rows: usize,
    pub writer_unique_domain_rows: usize,
    pub writer_unique_rows: usize,
    pub writer_domains: Vec<String>,
    pub topology_changed: bool,
    pub worker_limit: usize,
    pub observed_worker_count: usize,
    pub parallel_prepare_stages: u64,
    pub serial_prepare_stages: u64,
    pub stage_scans: Vec<FactoryStageExecutionDiagnostics>,
}

impl SealedFactoryWriterEvents {
    pub(crate) fn source_revision(&self) -> u64 {
        self.source_revision
    }

    pub(crate) fn entity_count(&self) -> usize {
        self.entity_count
    }

    pub(crate) fn topology_changed(&self) -> bool {
        self.topology_changed
    }

    pub(crate) fn wrote(&self, domain: FactoryWriterDomain) -> bool {
        self.domain_mask & domain.bit() != 0
    }

    pub(crate) fn rows(&self, domain: FactoryWriterDomain) -> &[usize] {
        &self.rows_by_domain[domain.index()]
    }

    pub(crate) fn all_rows(&self) -> Vec<usize> {
        let mut rows = self
            .rows_by_domain
            .iter()
            .flatten()
            .copied()
            .collect::<Vec<_>>();
        rows.sort_unstable();
        rows.dedup();
        rows
    }

    pub(crate) fn submitted_rows(&self) -> usize {
        self.submitted_rows
    }

    pub(crate) fn unique_domain_rows(&self) -> usize {
        self.rows_by_domain.iter().map(Vec::len).sum()
    }

    pub(crate) fn domain_names(&self) -> Vec<&'static str> {
        FactoryWriterDomain::ALL
            .into_iter()
            .filter(|domain| self.wrote(*domain))
            .map(FactoryWriterDomain::as_str)
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seal_orders_and_deduplicates_each_domain_and_the_union() {
        let mut events = FactoryWriterEvents::new(17, 8);
        events
            .record_rows(FactoryWriterDomain::Inventory, &[5, 1, 5, 3])
            .unwrap();
        events
            .record_rows(FactoryWriterDomain::Logistics, &[7, 3, 2])
            .unwrap();
        events.record_global(FactoryWriterDomain::Power);
        let sealed = events.seal();

        assert_eq!(sealed.source_revision(), 17);
        assert_eq!(sealed.entity_count(), 8);
        assert_eq!(sealed.rows(FactoryWriterDomain::Inventory), &[1, 3, 5]);
        assert_eq!(sealed.rows(FactoryWriterDomain::Logistics), &[2, 3, 7]);
        assert_eq!(sealed.all_rows(), vec![1, 2, 3, 5, 7]);
        assert_eq!(sealed.submitted_rows(), 7);
        assert_eq!(sealed.unique_domain_rows(), 6);
        assert_eq!(
            sealed.domain_names(),
            vec!["inventory", "logistics", "power"]
        );
    }

    #[test]
    fn invalid_row_fails_before_a_manifest_can_be_consumed() {
        let mut events = FactoryWriterEvents::new(4, 2);
        let error = events
            .record_rows(FactoryWriterDomain::Production, &[0, 2])
            .unwrap_err();
        assert!(error.to_string().contains("exceeds entity count 2"));
    }

    #[test]
    fn merge_rejects_revision_or_topology_drift() {
        let first = FactoryWriterEvents::new(8, 3).seal();
        let mut wrong_revision = FactoryWriterEvents::new(9, 3);
        assert!(wrong_revision.merge(&first).is_err());
        let mut wrong_count = FactoryWriterEvents::new(8, 4);
        assert!(wrong_count.merge(&first).is_err());
    }

    #[test]
    fn cumulative_snapshots_match_uncompacted_history_and_bound_retained_rows() {
        let mut compact = FactoryWriterEvents::new(19, 31);
        let mut original = compact.clone();
        for step in 0..512 {
            let mut events = FactoryWriterEvents::new(19, 31);
            for domain in FactoryWriterDomain::ALL {
                if (step + domain.index()) % 5 == 0 {
                    events.record_global(domain);
                } else {
                    let row = (step * 7 + domain.index()) % 31;
                    events
                        .record_rows(domain, &[row, (row + 23) % 31, row])
                        .unwrap();
                }
            }
            let sealed = events.seal();
            compact.merge(&sealed).unwrap();
            original.merge(&sealed).unwrap();
            let snapshot = compact.snapshot();
            // The oracle retains all historical duplicates, exactly as the
            // previous caller did before cloning and sealing every second.
            assert_eq!(snapshot, original.clone().seal(), "step {step}");
            assert_eq!(snapshot, compact.snapshot(), "repeat step {step}");
            assert!(compact.rows_by_domain.iter().all(|rows| rows.len() <= 31));
        }
        assert_eq!(compact.seal(), original.seal());
    }

    #[test]
    fn cumulative_snapshot_preserves_empty_global_and_rejected_merge_state() {
        let mut events = FactoryWriterEvents::new(5, 0);
        assert_eq!(events.snapshot(), events.clone().seal());
        events.record_topology_change();
        events.record_global(FactoryWriterDomain::Power);
        let expected = events.snapshot();
        assert!(expected.topology_changed());
        assert_eq!(expected.submitted_rows(), 0);
        assert!(expected.all_rows().is_empty());
        assert_eq!(expected.domain_names(), vec!["power", "topology"]);
        for wrong in [
            FactoryWriterEvents::new(6, 0),
            FactoryWriterEvents::new(5, 1),
        ] {
            assert!(events.merge(&wrong.seal()).is_err());
            assert_eq!(events.snapshot(), expected);
        }
        assert_eq!(events.seal(), expected);
    }
}
