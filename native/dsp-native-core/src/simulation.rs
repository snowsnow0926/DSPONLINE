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

        // The predicate above is deliberately stricter than the JS fast path.
        // Once admitted, only global clock/diagnostic fields can change and
        // this implementation mirrors fastForwardQuiescentState exactly.
        let base = next.base_value_mut();
        let elapsed_before = base
            .get("elapsedSeconds")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        let elapsed_after = rounded(elapsed_before + simulation_seconds, 4);
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
        // Normal-mode quiescent state has no speedrun wall clock. The budget
        // is accepted solely to prove segmentation equivalence.
        let _ = wall_seconds;
        next.record_production_history()?;
        next.revision += 1;
        let summary = request
            .include_diagnostics
            .then(|| next.summary())
            .transpose()?;
        *self = next;
        self.refresh_production_history_tiers();
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
