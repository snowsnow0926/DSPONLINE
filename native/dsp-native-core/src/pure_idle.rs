use anyhow::{anyhow, bail};
use serde_json::{Number, Value};

use crate::simulation::{CoreAdvanceMode, CoreAdvanceRequest, CoreAdvanceResult};
use crate::state::CoreState;

const ALGORITHM_VERSION: &str = "native-pure-idle-conservative-v2";
const EXACT_PREFIX_SECONDS: f64 = 1.0;
const MAX_ADVANCE_SECONDS: f64 = 30.0 * 24.0 * 60.0 * 60.0;
const EPSILON: f64 = 0.000_001;

fn number_at(value: Option<&Value>, path: &[&str]) -> f64 {
    let mut current = value;
    for key in path {
        current = current
            .and_then(Value::as_object)
            .and_then(|object| object.get(*key));
    }
    current.and_then(Value::as_f64).unwrap_or(0.0)
}

fn admission_reason(state: &CoreState, request: &CoreAdvanceRequest) -> Option<&'static str> {
    let base = state.base_value();
    if base.get("mode").and_then(Value::as_str) != Some("normal") {
        return Some("pure-idle-speedrun-unsupported");
    }
    if base.get("paused").and_then(Value::as_bool).unwrap_or(false) {
        return Some("pure-idle-state-paused");
    }
    if !base
        .get("timeWarp")
        .and_then(Value::as_object)
        .and_then(|time_warp| time_warp.get("enabled"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Some("pure-idle-time-warp-disabled");
    }
    if number_at(base.get("timeWarp"), &["pendingSimulationSeconds"]).abs() > EPSILON
        || number_at(base.get("timeWarp"), &["pendingWallSeconds"]).abs() > EPSILON
    {
        return Some("pure-idle-pending-budget-not-empty");
    }
    if request.simulation_seconds > EXACT_PREFIX_SECONDS && request.wall_seconds <= EPSILON {
        return Some("pure-idle-wall-budget-empty");
    }
    None
}

fn unsupported(
    state: &CoreState,
    request: &CoreAdvanceRequest,
    reason: impl Into<String>,
) -> anyhow::Result<CoreAdvanceResult> {
    Ok(CoreAdvanceResult {
        supported: false,
        exact_scope: "unsupported-domain",
        changed: false,
        previous_revision: state.revision,
        revision: state.revision,
        reason: Some(reason.into()),
        algorithm_version: Some(ALGORITHM_VERSION),
        exact_calibration_seconds: Some(0.0),
        approximated_seconds: Some(0.0),
        belt_scheduler: None,
        summary: request
            .include_diagnostics
            .then(|| state.summary())
            .transpose()?,
    })
}

fn exact_request(
    base_revision: u64,
    simulation_seconds: f64,
    wall_seconds: f64,
) -> CoreAdvanceRequest {
    CoreAdvanceRequest {
        base_revision,
        simulation_seconds,
        wall_seconds,
        advance_mode: CoreAdvanceMode::Exact,
        include_diagnostics: false,
    }
}

fn checked_elapsed_after_prefix(current: f64, tail_seconds: f64) -> anyhow::Result<f64> {
    let projected = current + tail_seconds;
    if !current.is_finite()
        || !tail_seconds.is_finite()
        || tail_seconds < 0.0
        || !projected.is_finite()
    {
        bail!("native pure-idle elapsed time overflow");
    }
    Ok(projected)
}

/// Conservative native pure-idle settlement.
///
/// Only the bounded prefix is simulated. The unproven tail advances the
/// authoritative clock and deliberately freezes every factory, inventory,
/// research, export, contract and Dyson counter. This is intentionally an
/// under-production policy: without a closed material ledger, extrapolating a
/// terminal result could duplicate prefilled rockets or sails.
pub(crate) fn advance(
    state: &mut CoreState,
    request: &CoreAdvanceRequest,
) -> anyhow::Result<CoreAdvanceResult> {
    if request.base_revision != state.revision {
        bail!("native pure-idle advance base revision is not current");
    }
    if !request.simulation_seconds.is_finite()
        || !request.wall_seconds.is_finite()
        || request.simulation_seconds < 0.0
        || request.wall_seconds < 0.0
        || request.simulation_seconds > MAX_ADVANCE_SECONDS
        || request.wall_seconds > MAX_ADVANCE_SECONDS
    {
        bail!("native pure-idle advance budget is invalid");
    }
    if let Some(reason) = admission_reason(state, request) {
        return unsupported(state, request, reason);
    }

    let exact_seconds = request.simulation_seconds.min(EXACT_PREFIX_SECONDS);
    let exact_wall_seconds = if request.simulation_seconds <= EPSILON {
        request.wall_seconds.min(EXACT_PREFIX_SECONDS)
    } else {
        request.wall_seconds * exact_seconds / request.simulation_seconds
    };
    let mut candidate = state.clone();
    let mut exact = candidate.advance_exact(&exact_request(
        candidate.revision,
        exact_seconds,
        exact_wall_seconds,
    ))?;
    if !exact.supported {
        return unsupported(
            state,
            request,
            exact
                .reason
                .take()
                .unwrap_or_else(|| "pure-idle-exact-prefix-unsupported".to_owned()),
        );
    }

    let tail_seconds = (request.simulation_seconds - exact_seconds).max(0.0);
    if tail_seconds > EPSILON {
        let requested_multiplier = request.simulation_seconds / request.wall_seconds;
        let effective_multiplier = number_at(
            candidate.base_value().get("timeWarp"),
            &["effectiveMultiplier"],
        )
        .max(1.0);
        let tolerance = EPSILON * effective_multiplier.max(requested_multiplier);
        if !requested_multiplier.is_finite()
            || (effective_multiplier - requested_multiplier).abs() > tolerance
        {
            return unsupported(state, request, "pure-idle-power-multiplier-changed");
        }

        let current_elapsed = candidate
            .base_value()
            .get("elapsedSeconds")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        let elapsed = checked_elapsed_after_prefix(current_elapsed, tail_seconds)?;
        candidate.base_value_mut().insert(
            "elapsedSeconds".to_owned(),
            Value::Number(
                Number::from_f64(elapsed)
                    .ok_or_else(|| anyhow!("native pure-idle elapsed time encode failed"))?,
            ),
        );
    }

    let previous_revision = state.revision;
    let revision = candidate.revision;
    let belt_scheduler = exact.belt_scheduler.take();
    *state = candidate;
    Ok(CoreAdvanceResult {
        supported: true,
        exact_scope: if tail_seconds > EPSILON {
            "pure-idle-conservative-v2"
        } else {
            "pure-idle-bounded-exact"
        },
        changed: exact.changed || tail_seconds > EPSILON,
        previous_revision,
        revision,
        reason: (tail_seconds > EPSILON).then(|| {
            "unproven pure-idle tail froze material-bearing systems after the exact prefix"
                .to_owned()
        }),
        algorithm_version: Some(ALGORITHM_VERSION),
        exact_calibration_seconds: Some(exact_seconds),
        approximated_seconds: Some(tail_seconds),
        belt_scheduler,
        summary: request
            .include_diagnostics
            .then(|| state.summary())
            .transpose()?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frozen_tail_clock_is_checked_without_touching_material_counters() {
        assert_eq!(checked_elapsed_after_prefix(10.25, 120.0).unwrap(), 130.25);
        assert!(checked_elapsed_after_prefix(f64::MAX, f64::MAX).is_err());
        assert!(checked_elapsed_after_prefix(1.0, -1.0).is_err());
    }
}
