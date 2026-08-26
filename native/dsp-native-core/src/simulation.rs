use anyhow::{anyhow, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::state::{CoreState, CoreStateSummary};

const MAX_ADVANCE_SECONDS: f64 = 30.0 * 24.0 * 60.0 * 60.0;
const EPSILON: f64 = 0.0001;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreAdvanceRequest {
    pub base_revision: u64,
    pub simulation_seconds: f64,
    pub wall_seconds: f64,
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
    pub summary: CoreStateSummary,
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
    if !array_is_empty(base, "handcraftQueue") || !array_is_empty(base, "constructionQueue") {
        return Some("craft-or-construction-queue-active");
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
        if request.base_revision != self.revision {
            bail!("native core advance base revision is not current");
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
                summary: self.summary()?,
            });
        }
        if let Some(reason) = clock_only_reason(self) {
            return Ok(CoreAdvanceResult {
                supported: false,
                exact_scope: "unsupported-domain",
                changed: false,
                previous_revision,
                revision: self.revision,
                reason: Some(reason.to_owned()),
                summary: self.summary()?,
            });
        }

        // The predicate above is deliberately stricter than the JS fast path.
        // Once admitted, only global clock/diagnostic fields can change and
        // this implementation mirrors fastForwardQuiescentState exactly.
        let mut next = self.clone();
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
        next.revision += 1;
        let summary = next.summary()?;
        *self = next;
        Ok(CoreAdvanceResult {
            supported: true,
            exact_scope: "clock-only",
            changed: true,
            previous_revision,
            revision: self.revision,
            reason: None,
            summary,
        })
    }
}
