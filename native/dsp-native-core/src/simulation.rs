use anyhow::{anyhow, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::state::{CoreState, CoreStateSummary};

const MAX_ADVANCE_SECONDS: f64 = 30.0 * 24.0 * 60.0 * 60.0;
const EPSILON: f64 = 0.0001;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize)]
pub enum CoreAdvanceMode {
    #[default]
    #[serde(rename = "exact")]
    Exact,
    #[serde(rename = "pure-idle-conservative-v2")]
    PureIdleConservativeV2,
    /// Deterministic three-window calibration mode. Its current v1 closed
    /// scope deliberately freezes the unproved tail; the distinct wire value
    /// prevents WAL replay from silently substituting the legacy one-shot
    /// conservative calibration semantics.
    #[serde(rename = "pure-idle-macro-v10")]
    PureIdleMacroV10,
    /// One-shot desktop offline settlement. This deliberately has a distinct
    /// wire identity from powered time warp so durable replay can never
    /// borrow a multiplier, power grant, or private calibration credit from a
    /// live PureIdleMacroV10 session.
    #[serde(rename = "offline-macro-v1")]
    OfflineMacroV1,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreAdvanceRequest {
    pub base_revision: u64,
    pub simulation_seconds: f64,
    pub wall_seconds: f64,
    #[serde(default)]
    pub advance_mode: CoreAdvanceMode,
    #[serde(default = "default_include_diagnostics")]
    pub include_diagnostics: bool,
}

fn default_include_diagnostics() -> bool {
    true
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreAdvanceResult {
    pub supported: bool,
    pub exact_scope: &'static str,
    pub changed: bool,
    pub previous_revision: u64,
    pub revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub algorithm_version: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exact_calibration_seconds: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approximated_seconds: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub belt_scheduler: Option<crate::belts::BeltSchedulerDiagnostics>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<CoreStateSummary>,
}

fn rounded(value: f64, digits: i32) -> f64 {
    let scale = 10_f64.powi(digits);
    (value * scale).round() / scale
}

/// The shared elapsed-clock boundary used by the actual native Exact step.
/// Replay callers must preserve the original step schedule: one bulk addition
/// is not a proof of repeated four-decimal rounding for fractional clocks.
#[inline]
pub(crate) fn exact_elapsed_after_step(elapsed_before: f64, step_seconds: f64) -> f64 {
    rounded(elapsed_before + step_seconds, 4)
}

fn array_is_empty(base: &Map<String, Value>, key: &str) -> bool {
    base.get(key)
        .and_then(Value::as_array)
        .is_some_and(Vec::is_empty)
}

fn object_is_empty(value: Option<&Value>) -> bool {
    value.and_then(Value::as_object).is_some_and(Map::is_empty)
}

fn object_has_positive_number(value: Option<&Value>) -> bool {
    value.and_then(Value::as_object).is_some_and(|object| {
        object
            .values()
            .any(|value| value.as_f64().is_some_and(|value| value >= 1.0))
    })
}

fn number_at(value: Option<&Value>, keys: &[&str]) -> f64 {
    let mut current = value;
    for key in keys {
        current = current
            .and_then(Value::as_object)
            .and_then(|object| object.get(*key));
    }
    current.and_then(Value::as_f64).unwrap_or(0.0)
}

fn bool_at(value: Option<&Value>, keys: &[&str]) -> bool {
    let mut current = value;
    for key in keys {
        current = current
            .and_then(Value::as_object)
            .and_then(|object| object.get(*key));
    }
    current.and_then(Value::as_bool).unwrap_or(false)
}

fn should_replay_exact_public_seconds(base: &Map<String, Value>, total: f64) -> bool {
    let elapsed = base
        .get("elapsedSeconds")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let recorded = base
        .get("historyRecordedAt")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    total > EPSILON
        && total <= 8.0 * 60.0 * 60.0
        && (total - total.round()).abs() <= EPSILON
        && (elapsed - recorded).abs() <= EPSILON
}

/// A short-lived proof that the ordinary offline tail has no export writer.
/// It is never persisted or accepted over IPC. The tail must preserve all four
/// counters until its already-proven elapsed interval is closed below.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct OfflineNoExportProgress {
    elapsed: f64,
    started: f64,
    amount: f64,
    last_minute: f64,
    total_exported: f64,
}

impl OfflineNoExportProgress {
    fn from_base(base: &Map<String, Value>, has_physical_exporter: bool) -> Result<Self, String> {
        if has_physical_exporter {
            return Err("offline export window has a physical exporter".to_owned());
        }
        let endgame = base
            .get("endgame")
            .and_then(Value::as_object)
            .ok_or_else(|| "offline export window endgame is missing".to_owned())?;
        // Both writers are explicit in engine.ts: runGalacticMaterialExporters
        // uses physical exporter rows; runGalacticExports additionally needs
        // legacy-network mode, autoDispatch and an enabled project.
        match endgame.get("exportInputMode").and_then(Value::as_str) {
            Some("building") => {}
            Some("legacy-network")
                if endgame.get("autoDispatch").and_then(Value::as_bool) == Some(false) => {}
            Some("legacy-network") => {
                // An empty/partial project map cannot prove all canonical
                // projects disabled. Automatic legacy dispatch remains
                // outside this narrow no-writer certificate.
                return Err("offline export window legacy writer is not disabled".to_owned());
            }
            _ => return Err("offline export window input mode is unknown".to_owned()),
        }
        let read = |object: &Map<String, Value>, key: &str| {
            object
                .get(key)
                .and_then(Value::as_f64)
                .filter(|value| value.is_finite() && *value >= 0.0)
                .ok_or_else(|| format!("offline export window {key} is invalid"))
        };
        let progress = Self {
            elapsed: read(base, "elapsedSeconds")?,
            started: read(endgame, "exportWindowStartedAt")?,
            amount: read(endgame, "exportWindowAmount")?,
            last_minute: read(endgame, "exportedLastMinute")?,
            total_exported: read(endgame, "totalExported")?,
        };
        if progress.started > progress.elapsed
            || exact_elapsed_after_step(progress.elapsed, 0.0) != progress.elapsed
        {
            return Err("offline export window clock is not an exact source boundary".to_owned());
        }
        Ok(progress)
    }

    fn apply_to_base(
        &self,
        base: &mut Map<String, Value>,
        has_physical_exporter: bool,
        tail_seconds: f64,
        request_seconds: f64,
    ) -> Result<f64, String> {
        // Up to eight hours the public JS exact session uses one-second steps
        // even with quantum/elevator stations. Longer and fractional requests
        // need an independently proven step schedule, not a guessed phase.
        if !tail_seconds.is_finite()
            || !request_seconds.is_finite()
            || tail_seconds < 0.0
            || tail_seconds.fract() != 0.0
            || request_seconds < tail_seconds
            || request_seconds.fract() != 0.0
            || request_seconds > 8.0 * 60.0 * 60.0
            // Keep the four-decimal scaled clock within exact integer range.
            || (self.elapsed + tail_seconds) * 10000.0 >= (1_u64 << 52) as f64
        {
            return Err("offline export window one-second budget is unsupported".to_owned());
        }
        if Self::from_base(base, has_physical_exporter)? != *self {
            return Err(
                "offline export window counters or source clock changed during the tail".to_owned(),
            );
        }
        let mut next = self.clone();
        let mut rolled_over = false;
        // Replay only scalar diagnostics, at most 28,800 steps. This shares
        // Exact's real rounding boundary, including large fractional source
        // clocks. No entity, JSON or persisted field is written in the loop.
        // A nonzero source amount belongs only to its first real window.
        for _ in 0..tail_seconds as u64 {
            let elapsed_after = exact_elapsed_after_step(next.elapsed, 1.0);
            if !elapsed_after.is_finite()
                || elapsed_after <= next.elapsed
                || elapsed_after * 10000.0 >= (1_u64 << 52) as f64
            {
                return Err("offline export window exact clock precision is unsupported".to_owned());
            }
            next.elapsed = elapsed_after;
            if next.started <= 0.0 {
                next.started = next.elapsed;
            }
            let window = next.elapsed - next.started;
            if window >= 10.0 - EPSILON {
                next.last_minute = rounded(next.amount * 60.0 / window, 2);
                if !next.last_minute.is_finite() {
                    return Err("offline export window rate overflowed".to_owned());
                }
                next.amount = 0.0;
                next.started = next.elapsed;
                rolled_over = true;
            }
        }
        // Return the proven final elapsed for the parent's atomic candidate
        // commit. The base clock, exports and every inventory stay untouched.
        let endgame = base
            .get_mut("endgame")
            .and_then(Value::as_object_mut)
            .expect("the validated export window endgame remains present");
        if next.started != self.started {
            endgame.insert(
                "exportWindowStartedAt".to_owned(),
                Value::from(next.started),
            );
        }
        if rolled_over {
            endgame.insert("exportWindowAmount".to_owned(), Value::from(0));
            endgame.insert(
                "exportedLastMinute".to_owned(),
                Value::from(next.last_minute),
            );
        }
        Ok(next.elapsed)
    }
}

pub(crate) fn capture_offline_no_export_progress(
    state: &CoreState,
) -> Result<OfflineNoExportProgress, String> {
    // The caller additionally requires an ordinary production certificate.
    // An empty/quiescent factory has a different public JS bulk clock rule.
    if state.entity_index.is_empty() {
        return Err(
            "offline export window requires a non-quiescent production certificate".to_owned(),
        );
    }
    OfflineNoExportProgress::from_base(
        state.base_value(),
        state.factory_topology.has_galactic_material_exporter
            || !state
                .factory_topology
                .galactic_material_exporter_indices
                .is_empty(),
    )
}

pub(crate) fn advance_offline_no_export_progress(
    state: &mut CoreState,
    source: &OfflineNoExportProgress,
    tail_seconds: f64,
    request_seconds: f64,
) -> Result<f64, String> {
    let has_physical_exporter = state.factory_topology.has_galactic_material_exporter
        || !state
            .factory_topology
            .galactic_material_exporter_indices
            .is_empty();
    source.apply_to_base(
        state.base_value_mut(),
        has_physical_exporter,
        tail_seconds,
        request_seconds,
    )
}

fn advance_quiescent_clock_boundary(
    base: &mut Map<String, Value>,
    simulation_seconds: f64,
) -> anyhow::Result<()> {
    let elapsed_before = base
        .get("elapsedSeconds")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let elapsed_after = exact_elapsed_after_step(elapsed_before, simulation_seconds);
    base.insert("elapsedSeconds".to_owned(), Value::from(elapsed_after));

    if let Some(endgame) = base.get_mut("endgame").and_then(Value::as_object_mut) {
        let mut started = endgame
            .get("exportWindowStartedAt")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        if started <= 0.0 {
            started = elapsed_before;
            endgame.insert("exportWindowStartedAt".to_owned(), Value::from(started));
        }
        let window = elapsed_after - started;
        if window >= 10.0 - EPSILON {
            let amount = endgame
                .get("exportWindowAmount")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            endgame.insert(
                "exportedLastMinute".to_owned(),
                Value::from(rounded(amount * 60.0 / window, 2)),
            );
            endgame.insert("exportWindowAmount".to_owned(), Value::from(0));
            let step_size: f64 = if simulation_seconds >= 24.0 * 60.0 * 60.0 {
                30.0
            } else if simulation_seconds > 8.0 * 60.0 * 60.0 {
                10.0
            } else {
                1.0
            };
            endgame.insert(
                "exportWindowStartedAt".to_owned(),
                Value::from((elapsed_after - step_size.min(simulation_seconds)).max(0.0)),
            );
        }
    }
    let active_planet = base
        .get("activePlanetId")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| anyhow!("native core active planet is missing"))?;
    if let Some(metrics) = base
        .get("planetMetrics")
        .and_then(Value::as_object)
        .and_then(|metrics| metrics.get(&active_planet))
        .cloned()
    {
        base.insert("metrics".to_owned(), metrics);
    }
    Ok(())
}

fn clock_only_reason(state: &CoreState) -> Option<&'static str> {
    if !state.entity_index.is_empty() || !state.belt_index.is_empty() {
        return Some("factory-records-active");
    }
    let base = state.base_value();
    if base.get("mode").and_then(Value::as_str) != Some("normal") {
        return Some("speedrun-clock-requires-domain-core");
    }
    if base
        .get("research")
        .and_then(Value::as_object)
        .and_then(|value| value.get("selectedTechId"))
        .is_some_and(|value| !value.is_null())
    {
        return Some("research-boundary-requires-domain-core");
    }
    let campaign = base.get("campaign").and_then(Value::as_object);
    if number_at(base.get("manualMined"), &[]) >= 1.0
        || object_has_positive_number(base.get("totalProduced"))
        || !array_is_empty(base, "blueprints")
        || campaign
            .and_then(|value| value.get("completedTaskIds"))
            .and_then(Value::as_array)
            .is_none_or(|value| !value.is_empty())
        || campaign
            .and_then(|value| value.get("rewardedTaskIds"))
            .and_then(Value::as_array)
            .is_none_or(|value| !value.is_empty())
        || campaign
            .and_then(|value| value.get("activeTaskId"))
            .and_then(Value::as_str)
            != Some("mine_first_ore")
        || campaign
            .and_then(|value| value.get("activeChapterId"))
            .and_then(Value::as_str)
            != Some("foundation")
    {
        return Some("campaign-completion-requires-domain-core");
    }
    if !array_is_empty(base, "handcraftQueue") || !array_is_empty(base, "constructionQueue") {
        return Some("craft-or-construction-queue-active");
    }
    let construction_automation = base.get("constructionAutomation");
    if !object_is_empty(
        construction_automation
            .and_then(Value::as_object)
            .and_then(|value| value.get("jobs")),
    ) || bool_at(construction_automation, &["enabled"])
        && !object_is_empty(
            construction_automation
                .and_then(Value::as_object)
                .and_then(|value| value.get("targetStock")),
        )
    {
        return Some("construction-automation-active");
    }
    if !base
        .get("exploration")
        .and_then(Value::as_object)
        .and_then(|value| value.get("missions"))
        .and_then(Value::as_array)
        .is_some_and(Vec::is_empty)
    {
        return Some("exploration-active");
    }
    let time_warp = base.get("timeWarp");
    if bool_at(time_warp, &["enabled"])
        || time_warp
            .and_then(Value::as_object)
            .and_then(|value| value.get("controllerEntityId"))
            .is_some_and(|value| !value.is_null())
        || number_at(time_warp, &["pendingSimulationSeconds"]).abs() > EPSILON
        || number_at(time_warp, &["pendingWallSeconds"]).abs() > EPSILON
    {
        return Some("time-warp-active");
    }
    if number_at(base.get("dysonSwarm"), &["totalLaunched"]) > 0.0
        || number_at(base.get("dysonSphere"), &["totalRocketsLaunched"]) > 0.0
    {
        return Some("dyson-active");
    }
    if !object_is_empty(base.get("systemSpaceStations")) {
        return Some("system-space-station-active");
    }
    if base
        .get("quantumLogisticsNetwork")
        .and_then(Value::as_object)
        .and_then(|value| value.get("inventory"))
        .is_some_and(|value| !object_is_empty(Some(value)))
    {
        return Some("quantum-inventory-active");
    }
    let endgame = base.get("endgame").and_then(Value::as_object);
    if endgame
        .and_then(|value| value.get("activeInfiniteResearchId"))
        .is_some_and(|value| !value.is_null())
        || endgame
            .and_then(|value| value.get("constructionActivity"))
            .and_then(Value::as_object)
            .and_then(|value| value.get("activityId"))
            .is_some_and(|value| value.as_str().is_some_and(|id| !id.is_empty()))
        || endgame
            .and_then(|value| value.get("exportProjects"))
            .and_then(Value::as_object)
            .is_some_and(|projects| {
                projects
                    .values()
                    .any(|project| bool_at(Some(project), &["enabled"]))
            })
    {
        return Some("endgame-activity-active");
    }
    None
}

impl CoreState {
    pub fn advance(&mut self, request: &CoreAdvanceRequest) -> anyhow::Result<CoreAdvanceResult> {
        match request.advance_mode {
            CoreAdvanceMode::PureIdleConservativeV2 => {
                return crate::pure_idle::advance(self, request);
            }
            CoreAdvanceMode::PureIdleMacroV10 => {
                return crate::pure_idle::advance_macro_v10(self, request);
            }
            CoreAdvanceMode::OfflineMacroV1 => {
                return crate::pure_idle::advance_offline_macro_v1(self, request);
            }
            CoreAdvanceMode::Exact => {}
        }
        self.advance_exact(request)
    }

    pub(crate) fn advance_exact(
        &mut self,
        request: &CoreAdvanceRequest,
    ) -> anyhow::Result<CoreAdvanceResult> {
        self.advance_exact_with_construction_policy(request, false)
    }

    /// Internal calibration path that retains construction-center demand in
    /// the ordinary power plan while leaving the construction domain itself
    /// untouched. Public exact advances deliberately keep the historical
    /// player-facing behavior above.
    pub(crate) fn advance_exact_isolating_construction(
        &mut self,
        request: &CoreAdvanceRequest,
    ) -> anyhow::Result<CoreAdvanceResult> {
        self.advance_exact_with_construction_policy(request, true)
    }

    fn advance_exact_with_construction_policy(
        &mut self,
        request: &CoreAdvanceRequest,
        isolate_construction_automation: bool,
    ) -> anyhow::Result<CoreAdvanceResult> {
        let profile_enabled = std::env::var_os("DSP_NATIVE_CORE_PROFILE").is_some();
        let mut profile_checkpoint = std::time::Instant::now();
        macro_rules! profile_mark {
            ($label:literal) => {
                if profile_enabled {
                    eprintln!(
                        "DSP_NATIVE_CORE_PROFILE\tadvance-{}\t{:.3}",
                        $label,
                        profile_checkpoint.elapsed().as_secs_f64() * 1_000.0
                    );
                    profile_checkpoint = std::time::Instant::now();
                }
            };
        }
        macro_rules! profile_last {
            ($label:literal) => {
                if profile_enabled {
                    eprintln!(
                        "DSP_NATIVE_CORE_PROFILE\tadvance-{}\t{:.3}",
                        $label,
                        profile_checkpoint.elapsed().as_secs_f64() * 1_000.0
                    );
                }
            };
        }
        if request.base_revision != self.revision {
            bail!("native core advance base revision is not current");
        }
        if self.factory_static_admission_reason().is_none() {
            self.refresh_factory_static_admission()?;
        }
        if !request.simulation_seconds.is_finite()
            || !request.wall_seconds.is_finite()
            || request.simulation_seconds < 0.0
            || request.wall_seconds < 0.0
        {
            bail!("native core advance budget is invalid");
        }
        let previous_revision = self.revision;
        let paused = self
            .base_value()
            .get("paused")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let simulation_seconds = if paused {
            0.0
        } else {
            request.simulation_seconds.min(MAX_ADVANCE_SECONDS)
        };
        let wall_seconds = if paused {
            0.0
        } else {
            request.wall_seconds.min(MAX_ADVANCE_SECONDS)
        };
        if simulation_seconds <= EPSILON && wall_seconds <= EPSILON {
            return Ok(CoreAdvanceResult {
                supported: true,
                exact_scope: "no-change",
                changed: false,
                previous_revision,
                revision: self.revision,
                reason: None,
                algorithm_version: None,
                exact_calibration_seconds: None,
                approximated_seconds: None,
                belt_scheduler: None,
                summary: request
                    .include_diagnostics
                    .then(|| self.summary())
                    .transpose()?,
            });
        }
        let clock_reason = clock_only_reason(self);
        let simple_factory_reason = if clock_reason.is_some() {
            crate::simple_factory::admission_reason(self)?
        } else {
            Some("quiescent-state")
        };
        if let (Some(clock_reason), Some(simple_reason)) = (clock_reason, simple_factory_reason) {
            return Ok(CoreAdvanceResult {
                supported: false,
                exact_scope: "unsupported-domain",
                changed: false,
                previous_revision,
                revision: self.revision,
                reason: Some(if clock_reason == "factory-records-active" {
                    simple_reason.to_owned()
                } else {
                    clock_reason.to_owned()
                }),
                algorithm_version: None,
                exact_calibration_seconds: None,
                approximated_seconds: None,
                belt_scheduler: None,
                summary: request
                    .include_diagnostics
                    .then(|| self.summary())
                    .transpose()?,
            });
        }

        if simple_factory_reason.is_none() {
            let mut prepared = crate::simple_factory::prepare_advance(
                self,
                simulation_seconds,
                wall_seconds,
                isolate_construction_automation,
            )?;
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
            profile_mark!("simulate");
            let next_revision = previous_revision
                .checked_add(1)
                .ok_or_else(|| anyhow!("native core revision exhausted"))?;
            let campaign_metric_writer_indices = prepared.campaign_metric_writer_indices.take();
            let campaign_projection_update =
                self.campaign_projection_runtime.prepare_simulation_update(
                    self,
                    &prepared.entities,
                    campaign_metric_writer_indices.as_deref(),
                    next_revision,
                );
            let cached_campaign_factory_metrics =
                if crate::campaign::factory_metrics_needed(&prepared.base) {
                    campaign_projection_update.factory_metrics(self)
                } else {
                    None
                };
            let sampled_campaign_factory_metrics = self
                .record_production_history_with_campaign_metrics(
                    &mut prepared.base,
                    &prepared.entities,
                    Some(prepared.belt_flow),
                    cached_campaign_factory_metrics.as_ref(),
                    Some(&prepared.writer_events),
                )?;
            if let Some(production_history_tiers) = prepared.production_history_tiers.as_mut() {
                production_history_tiers.refresh_after_internal_sample(&prepared.base);
            }
            profile_mark!("production-history");
            crate::campaign::synchronize_with_factory_metrics(
                self,
                &mut prepared.base,
                &prepared.entities,
                cached_campaign_factory_metrics.or(sampled_campaign_factory_metrics),
            )?;
            crate::campaign::synchronize_orbital_station_eligibility(&mut prepared.base)?;
            profile_mark!("campaign");
            crate::speedrun::evaluate(self, &mut prepared.base)?;
            profile_mark!("speedrun");
            let belt_scheduler = prepared.belt_scheduler.clone();
            let summary = self.commit_simulated_state_with_campaign_projection_update_and_history(
                prepared.base,
                prepared.entities,
                prepared.belt_commit,
                next_revision,
                request.include_diagnostics,
                crate::state::PreparedSimulationRuntimeUpdates {
                    campaign_projection: campaign_projection_update,
                    production_history_tiers: prepared.production_history_tiers,
                },
            )?;
            self.install_prepared_belt_routes(belt_routes);
            self.install_prepared_belt_activity(belt_activity);
            self.install_prepared_logistics_buffer_runtime(logistics_buffer_runtime);
            self.install_prepared_material_delivery_runtime(material_delivery_runtime);
            self.install_prepared_ordinary_production_runtime(ordinary_production_runtime);
            self.install_prepared_planet_metrics_runtime(planet_metrics_runtime);
            self.install_prepared_power_probe_runtime(power_probe_runtime);
            self.install_prepared_local_peer_directory(local_peer_directory);
            self.install_prepared_quantum_logistics_directory(quantum_logistics_directory);
            self.install_prepared_construction_runtime(construction_runtime);
            self.install_prepared_station_mode_transition_runtime(station_mode_transition_runtime);
            self.install_prepared_quantum_transition_runtime(quantum_transition_runtime);
            self.install_prepared_interstellar_peer_directory(interstellar_peer_directory);
            self.install_prepared_interstellar_route_activity(interstellar_route_activity);
            self.install_factory_execution_diagnostics(factory_execution_diagnostics)?;
            profile_mark!("commit-state");
            if request.include_diagnostics {
                profile_last!("summary");
            }
            return Ok(CoreAdvanceResult {
                supported: true,
                exact_scope: "simple-factory-v1",
                changed: true,
                previous_revision,
                revision: self.revision,
                reason: None,
                algorithm_version: None,
                exact_calibration_seconds: None,
                approximated_seconds: None,
                belt_scheduler: Some(belt_scheduler),
                summary,
            });
        }

        let mut next = self.clone();
        profile_last!("clone-state");

        // A compressed player-authority Exact batch must preserve every
        // public one-second boundary, including diagnostics. Quiescent states
        // skip the factory loop, so replay those cheap clock/history
        // boundaries here instead of collapsing the whole batch to one
        // observation. Fractional, unaligned and >8h legacy requests retain
        // their established one-call shape.
        if should_replay_exact_public_seconds(next.base_value(), simulation_seconds) {
            for _ in 0..simulation_seconds.round() as u64 {
                advance_quiescent_clock_boundary(next.base_value_mut(), 1.0)?;
                next.record_production_history()?;
                next.refresh_production_history_tiers();
            }
        } else {
            advance_quiescent_clock_boundary(next.base_value_mut(), simulation_seconds)?;
            next.record_production_history()?;
            next.refresh_production_history_tiers();
        }
        // Normal-mode quiescent state has no speedrun wall clock. The budget
        // is accepted solely to prove segmentation equivalence.
        let _ = wall_seconds;
        next.revision += 1;
        let summary = request
            .include_diagnostics
            .then(|| next.summary())
            .transpose()?;
        *self = next;
        Ok(CoreAdvanceResult {
            supported: true,
            exact_scope: "clock-only",
            changed: true,
            previous_revision,
            revision: self.revision,
            reason: None,
            algorithm_version: None,
            exact_calibration_seconds: None,
            approximated_seconds: None,
            belt_scheduler: None,
            summary,
        })
    }
}

#[cfg(test)]
mod offline_no_export_progress_tests {
    use super::*;
    use serde_json::json;

    fn base(elapsed: f64, started: f64, amount: f64, rate: f64) -> Map<String, Value> {
        json!({
            "elapsedSeconds": elapsed,
            "endgame": {
                "exportInputMode": "building", "autoDispatch": true,
                "exportProjects": { "fixture": { "enabled": false } },
                "totalExported": 9000, "exportWindowStartedAt": started,
                "exportWindowAmount": amount, "exportedLastMinute": rate,
            },
        })
        .as_object()
        .unwrap()
        .clone()
    }

    // Independent literal oracle for engine.ts simulateStep finalization,
    // not fastForwardQuiescentState's different one-call bulk diagnostics.
    fn exact_production_seconds(base: &mut Map<String, Value>, seconds: u64) {
        for _ in 0..seconds {
            let elapsed =
                ((base["elapsedSeconds"].as_f64().unwrap() + 1.0) * 10000.0).round() / 10000.0;
            base.insert("elapsedSeconds".to_owned(), Value::from(elapsed));
            let endgame = base.get_mut("endgame").unwrap().as_object_mut().unwrap();
            let mut started = endgame["exportWindowStartedAt"].as_f64().unwrap();
            if started <= 0.0 {
                started = elapsed;
                endgame.insert("exportWindowStartedAt".to_owned(), Value::from(started));
            }
            if elapsed - started >= 10.0 - 0.0001 {
                let amount = endgame["exportWindowAmount"].as_f64().unwrap();
                let rate = (amount * 60.0 / (elapsed - started) * 100.0).round() / 100.0;
                endgame.insert("exportedLastMinute".to_owned(), Value::from(rate));
                endgame.insert("exportWindowAmount".to_owned(), Value::from(0));
                endgame.insert("exportWindowStartedAt".to_owned(), Value::from(elapsed));
            }
        }
    }

    fn advance(base: &mut Map<String, Value>, seconds: u64) -> Result<(), String> {
        let proof = OfflineNoExportProgress::from_base(base, false)?;
        let final_elapsed = proof.apply_to_base(base, false, seconds as f64, seconds as f64)?;
        // The outer macro owns elapsed, just as the real integration does.
        base.insert("elapsedSeconds".to_owned(), Value::from(final_elapsed));
        Ok(())
    }

    #[test]
    fn offline_no_export_progress_returns_proven_fractional_elapsed_without_writing_parent_clock() {
        let mut candidate = base(30.0043, 21.0043, 42.0, 17.5);
        let proof = OfflineNoExportProgress::from_base(&candidate, false).unwrap();
        let final_elapsed = proof
            .apply_to_base(&mut candidate, false, 600.0, 600.0)
            .unwrap();
        assert_eq!(final_elapsed, 630.0043);
        assert_eq!(candidate["elapsedSeconds"], 30.0043);
        assert_eq!(candidate["endgame"]["exportWindowStartedAt"], 621.0043);
        assert_eq!(candidate["endgame"]["exportWindowAmount"], 0);
        assert_eq!(candidate["endgame"]["exportedLastMinute"], 0.0);
        assert_eq!(candidate["endgame"]["totalExported"], 9000);
    }

    #[test]
    fn offline_no_export_progress_has_independent_fractional_and_long_clock_boundaries() {
        for (elapsed, started, seconds, final_elapsed, final_started, final_amount, final_rate) in [
            (30.0043, 21.0043, 0, 30.0043, 21.0043, 42.0, 17.5),
            (30.0043, 21.0043, 1, 31.0043, 31.0043, 0.0, 252.0),
            (30.0043, 21.0043, 10, 40.0043, 31.0043, 0.0, 252.0),
            (30.0043, 21.0043, 11, 41.0043, 41.0043, 0.0, 0.0),
            (
                60.0043,
                51.0043,
                28_770,
                28_830.004_3,
                28_821.004_3,
                0.0,
                0.0,
            ),
            (
                268_435_455.999_9,
                268_435_446.999_9,
                11,
                268_435_466.999_9,
                268_435_466.999_9,
                0.0,
                0.0,
            ),
            (
                1_000_000_000.004_3,
                999_999_991.004_3,
                28_800,
                1_000_028_800.004_3,
                1_000_028_791.004_3,
                0.0,
                0.0,
            ),
            (
                400_000_000_000.25,
                399_999_999_991.25,
                28_800,
                400_000_028_800.25,
                400_000_028_791.25,
                0.0,
                0.0,
            ),
        ] {
            let mut actual = base(elapsed, started, 42.0, 17.5);
            let mut oracle = actual.clone();
            exact_production_seconds(&mut oracle, seconds);
            advance(&mut actual, seconds).unwrap();
            assert_eq!(actual, oracle, "source {elapsed}, seconds {seconds}");
            assert_eq!(actual["elapsedSeconds"], final_elapsed);
            assert_eq!(actual["endgame"]["exportWindowStartedAt"], final_started);
            assert_eq!(
                actual["endgame"]["exportWindowAmount"].as_f64().unwrap(),
                final_amount
            );
            assert_eq!(actual["endgame"]["exportedLastMinute"], final_rate);
        }
    }

    #[test]
    fn offline_no_export_progress_rejects_off_grid_rounding_neighbors_without_mutation() {
        assert_eq!(exact_elapsed_after_step(0.0, 0.000049), 0.0);
        assert_eq!(exact_elapsed_after_step(0.0, 0.00005), 0.0001);
        assert_eq!(exact_elapsed_after_step(30.0043, 1.0), 31.0043);
        let canonical = 30.0043_f64;
        for elapsed in [
            f64::from_bits(canonical.to_bits() - 1),
            f64::from_bits(canonical.to_bits() + 1),
            30.00430000001,
            30.000049,
            30.00005,
            30.99995,
        ] {
            let unchanged = base(elapsed, 21.0, 42.0, 17.5);
            let before = unchanged.clone();
            assert!(
                OfflineNoExportProgress::from_base(&unchanged, false).is_err(),
                "off-grid source {elapsed}"
            );
            assert_eq!(unchanged, before);
        }
    }

    #[test]
    fn offline_no_export_progress_precision_limit_rejects_before_any_window_commit() {
        let elapsed = (((1_u64 << 52) as f64) / 10000.0).floor() - 1.0;
        let original = base(elapsed, elapsed - 9.0, 42.0, 17.5);
        let proof = OfflineNoExportProgress::from_base(&original, false).unwrap();
        let mut accepted = original.clone();
        assert_eq!(
            proof.apply_to_base(&mut accepted, false, 1.0, 1.0).unwrap(),
            elapsed + 1.0
        );
        let mut rejected = original.clone();
        assert!(proof.apply_to_base(&mut rejected, false, 2.0, 2.0).is_err());
        assert_eq!(rejected, original);
    }

    #[test]
    fn offline_no_export_progress_preserves_600_and_8h_public_phases() {
        for (tail, expected_started) in [(570, 621.0), (28_770, 28_821.0)] {
            let mut actual = base(60.0, 51.0, 0.0, 0.0);
            let mut expected = actual.clone();
            exact_production_seconds(&mut expected, tail);
            advance(&mut actual, tail).unwrap();
            assert_eq!(actual, expected);
            assert_eq!(actual["endgame"]["exportWindowStartedAt"], expected_started);
        }
    }

    #[test]
    fn offline_no_export_progress_consumes_nonzero_amount_only_at_first_real_window() {
        for (seconds, started, amount, rate) in [
            (0, 52.0, 42.0, 17.5),
            (1, 52.0, 42.0, 17.5),
            (2, 62.0, 0.0, 252.0),
            (11, 62.0, 0.0, 252.0),
            (12, 72.0, 0.0, 0.0),
            (570, 622.0, 0.0, 0.0),
        ] {
            let mut actual = base(60.0, 52.0, 42.0, 17.5);
            let mut expected = actual.clone();
            exact_production_seconds(&mut expected, seconds);
            advance(&mut actual, seconds).unwrap();
            assert_eq!(actual, expected);
            assert_eq!(actual["endgame"]["exportWindowStartedAt"], started);
            assert_eq!(
                actual["endgame"]["exportWindowAmount"].as_f64().unwrap(),
                amount
            );
            assert_eq!(actual["endgame"]["exportedLastMinute"], rate);
            assert_eq!(actual["endgame"]["totalExported"], 9000);
        }
    }

    #[test]
    fn offline_no_export_progress_handles_initialization_fractional_phase_and_old_windows() {
        for (elapsed, started) in [
            (0.0, 0.0),
            (30.0, 0.0),
            (60.25, 51.25),
            (60.1234, 51.1234),
            (60.0, 0.01),
            (60.0, 50.0001),
        ] {
            for seconds in [1, 2, 9, 10, 11, 12, 21, 37, 600] {
                let mut actual = base(elapsed, started, 13.0, 83.25);
                let mut expected = actual.clone();
                exact_production_seconds(&mut expected, seconds);
                advance(&mut actual, seconds).unwrap();
                assert_eq!(
                    actual, expected,
                    "elapsed {elapsed}, started {started}, seconds {seconds}"
                );
            }
        }
    }

    #[test]
    fn offline_no_export_progress_segmented_checkpoint_resume_matches_single_call() {
        for elapsed in [60.25, 60.0043, 1_000_000_000.999_9] {
            let mut single = base(elapsed, elapsed - 9.0, 73.0, 11.0);
            let mut resumed = single.clone();
            advance(&mut single, 570).unwrap();
            for seconds in [7, 3, 60, 1, 499] {
                advance(&mut resumed, seconds).unwrap();
                resumed = serde_json::from_slice(&serde_json::to_vec(&resumed).unwrap()).unwrap();
            }
            assert_eq!(single, resumed);
        }
    }

    #[test]
    fn offline_no_export_progress_rejects_actual_or_unknown_writers() {
        let building = base(60.0, 51.0, 0.0, 0.0);
        assert!(OfflineNoExportProgress::from_base(&building, true).is_err());
        for mode in ["legacy-network", "unknown"] {
            let mut unsupported = building.clone();
            unsupported["endgame"]["exportInputMode"] = Value::from(mode);
            unsupported["endgame"]["exportProjects"]["fixture"]["enabled"] = Value::from(true);
            assert!(OfflineNoExportProgress::from_base(&unsupported, false).is_err());
        }
        let mut disabled = building;
        disabled["endgame"]["exportInputMode"] = Value::from("legacy-network");
        assert!(OfflineNoExportProgress::from_base(&disabled, false).is_err());
        disabled["endgame"]["exportProjects"]["fixture"]
            .as_object_mut()
            .unwrap()
            .remove("enabled");
        assert!(OfflineNoExportProgress::from_base(&disabled, false).is_err());
        disabled["endgame"]["autoDispatch"] = Value::from(false);
        assert!(OfflineNoExportProgress::from_base(&disabled, false).is_ok());
    }

    #[test]
    fn offline_no_export_progress_rejects_changed_counters_and_clock_atomically() {
        let original = base(60.0, 51.0, 42.0, 17.5);
        let proof = OfflineNoExportProgress::from_base(&original, false).unwrap();
        for field in [
            "exportWindowStartedAt",
            "exportWindowAmount",
            "exportedLastMinute",
            "totalExported",
        ] {
            let mut changed = original.clone();
            changed["endgame"][field] = Value::from(123.0);
            let before = changed.clone();
            assert!(
                proof
                    .apply_to_base(&mut changed, false, 600.0, 600.0)
                    .is_err()
            );
            assert_eq!(changed, before);
        }
        let mut changed = original;
        changed.insert("elapsedSeconds".to_owned(), Value::from(61));
        let before = changed.clone();
        assert!(
            proof
                .apply_to_base(&mut changed, false, 600.0, 600.0)
                .is_err()
        );
        assert_eq!(changed, before);
    }

    #[test]
    fn offline_no_export_progress_rejects_unknown_step_budgets_and_rate_overflow_atomically() {
        for (tail, request) in [
            (0.5, 600.0),
            (1.0, 600.5),
            (600.0, 599.0),
            (600.0, 28_801.0),
            (-1.0, 600.0),
            (f64::NAN, 600.0),
        ] {
            let mut unchanged = base(60.0, 51.0, 13.0, 17.5);
            let proof = OfflineNoExportProgress::from_base(&unchanged, false).unwrap();
            let before = unchanged.clone();
            assert!(
                proof
                    .apply_to_base(&mut unchanged, false, tail, request)
                    .is_err()
            );
            assert_eq!(unchanged, before);
        }
        let mut overflow = base(60.0, 51.0, f64::MAX, 1.0);
        let proof = OfflineNoExportProgress::from_base(&overflow, false).unwrap();
        let before = overflow.clone();
        assert!(
            proof
                .apply_to_base(&mut overflow, false, 1.0, 600.0)
                .is_err()
        );
        assert_eq!(overflow, before);
        assert!(OfflineNoExportProgress::from_base(&base(60.0, 61.0, 0.0, 0.0), false).is_err());
        assert!(OfflineNoExportProgress::from_base(&base(60.0, 51.0, -1.0, 0.0), false).is_err());
    }
}
