use std::collections::HashSet;

use anyhow::anyhow;
use serde_json::{Map, Number, Value};

use crate::state::CoreState;

const MAX_WALL_SECONDS: f64 = 30.0 * 24.0 * 60.0 * 60.0;
const DEPRECATED_TECHNOLOGIES: [&str; 7] = [
    "orbital_elevator_engineering",
    "orbital_multi_cargo_bus",
    "orbital_energy_recovery",
    "system_space_station_engineering",
    "orbital_modular_assembly",
    "autonomous_station_construction",
    "unified_system_logistics_protocol",
];

fn finite_number(value: Option<&Value>) -> f64 {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .unwrap_or(0.0)
}

fn set_number(object: &mut Map<String, Value>, key: &str, value: f64) -> anyhow::Result<()> {
    object.insert(
        key.to_owned(),
        Number::from_f64(value)
            .map(Value::Number)
            .ok_or_else(|| anyhow!("native speedrun produced a non-finite number"))?,
    );
    Ok(())
}

fn rounded_seconds(value: f64) -> f64 {
    (value.max(0.0) * 1_000_000.0).round() / 1_000_000.0
}

fn completed_tech_ids(base: &Map<String, Value>) -> HashSet<&str> {
    base.get("research")
        .and_then(Value::as_object)
        .and_then(|research| research.get("completedTechIds"))
        .and_then(Value::as_array)
        .map(|values| values.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default()
}

fn milestone_complete(speedrun: &Map<String, Value>, target_id: &str) -> bool {
    speedrun
        .get("milestones")
        .and_then(Value::as_object)
        .and_then(|milestones| milestones.get(target_id))
        .and_then(Value::as_object)
        .and_then(|milestone| milestone.get("completed"))
        .and_then(Value::as_bool)
        == Some(true)
}

fn baseline_number(speedrun: &Map<String, Value>, key: &str) -> f64 {
    speedrun
        .get("baseline")
        .and_then(Value::as_object)
        .map(|baseline| finite_number(baseline.get(key)))
        .unwrap_or(0.0)
}

fn finite_technology_progress<'a>(
    technology_ids: impl Iterator<Item = &'a String>,
    completed: &HashSet<&str>,
    baseline_ids: &HashSet<&str>,
) -> (usize, usize) {
    technology_ids
        .filter(|id| !DEPRECATED_TECHNOLOGIES.contains(&id.as_str()))
        .filter(|id| !baseline_ids.contains(id.as_str()))
        .fold((0, 0), |(target, current), id| {
            (
                target + 1,
                current + usize::from(completed.contains(id.as_str())),
            )
        })
}

pub(crate) fn evaluate(state: &CoreState, base: &mut Map<String, Value>) -> anyhow::Result<()> {
    let Some(mut speedrun) = base
        .remove("speedrun")
        .filter(|value| !value.is_null())
        .and_then(|value| value.as_object().cloned())
    else {
        return Ok(());
    };
    if speedrun.get("enabled").and_then(Value::as_bool) != Some(true) {
        base.insert("speedrun".to_owned(), Value::Object(speedrun));
        return Ok(());
    }
    let elapsed = rounded_seconds(finite_number(speedrun.get("elapsedActiveSeconds")));
    let completed = completed_tech_ids(base);
    let baseline_ids = speedrun
        .get("baseline")
        .and_then(Value::as_object)
        .and_then(|baseline| baseline.get("completedTechIds"))
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .collect::<HashSet<_>>()
        })
        .unwrap_or_default();
    // The technology catalog is immutable and small. A second HashSet plus a
    // parallel task costs more than the probe itself; one deterministic pass
    // computes both counts without allocating another catalog-sized table.
    let (all_target, all_current) =
        finite_technology_progress(state.catalog.technologies.keys(), &completed, &baseline_ids);
    let rocket_current = (base
        .get("dysonSphere")
        .and_then(Value::as_object)
        .map(|sphere| finite_number(sphere.get("totalRocketsLaunched")))
        .unwrap_or(0.0)
        - baseline_number(&speedrun, "rocketsLaunched"))
    .floor()
    .max(0.0);
    let white_current = (base
        .get("totalProduced")
        .and_then(Value::as_object)
        .map(|produced| finite_number(produced.get("universe_matrix")))
        .unwrap_or(0.0)
        - baseline_number(&speedrun, "whiteMatrixProduced"))
    .floor()
    .max(0.0);
    let progress = [
        ("all_technologies", all_current >= all_target),
        ("dyson_rockets_10000", rocket_current >= 10_000.0),
        ("white_matrix_1m", white_current >= 1_000_000.0),
    ];
    for (target_id, complete) in progress {
        if !complete || milestone_complete(&speedrun, target_id) {
            continue;
        }
        speedrun
            .get_mut("milestones")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native speedrun milestones are missing"))?
            .insert(
                target_id.to_owned(),
                serde_json::json!({
                    "completed": true,
                    "completedAtSeconds": elapsed,
                }),
            );
    }
    base.insert("speedrun".to_owned(), Value::Object(speedrun));
    Ok(())
}

pub(crate) fn advance_clock(
    state: &CoreState,
    base: &mut Map<String, Value>,
    wall_seconds: f64,
) -> anyhow::Result<()> {
    if wall_seconds <= 0.0 || base.get("paused").and_then(Value::as_bool) == Some(true) {
        return Ok(());
    }
    let Some(speedrun) = base.get_mut("speedrun").and_then(Value::as_object_mut) else {
        return Ok(());
    };
    if speedrun.get("enabled").and_then(Value::as_bool) != Some(true) {
        return Ok(());
    }
    let elapsed = finite_number(speedrun.get("elapsedActiveSeconds"));
    set_number(
        speedrun,
        "elapsedActiveSeconds",
        rounded_seconds(elapsed + wall_seconds.min(MAX_WALL_SECONDS)),
    )?;
    evaluate(state, base)
}

pub(crate) fn admission_reason(state: &CoreState) -> anyhow::Result<Option<&'static str>> {
    let base = state.base_value();
    match base.get("mode").and_then(Value::as_str) {
        Some("normal") => {
            if base.get("speedrun").is_none_or(Value::is_null) {
                return Ok(None);
            }
            return Ok(Some("normal-factory-speedrun-state-invalid"));
        }
        Some("speedrun") => {}
        _ => return Ok(Some("factory-mode-invalid")),
    }
    let speedrun = base
        .get("speedrun")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native speedrun state is missing"))?;
    if speedrun.get("enabled").and_then(Value::as_bool) != Some(true)
        || speedrun.get("mode").and_then(Value::as_str) != Some("speedrun")
        || speedrun.get("rulesetVersion").and_then(Value::as_str) != Some("speedrun-v1")
        || speedrun.get("seasonId").and_then(Value::as_str) != Some("season_01")
        || speedrun
            .get("elapsedActiveSeconds")
            .and_then(Value::as_f64)
            .is_none_or(|value| !value.is_finite() || value < 0.0)
    {
        return Ok(Some("speedrun-state-invalid"));
    }
    let baseline = speedrun
        .get("baseline")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native speedrun baseline is missing"))?;
    if baseline
        .get("completedTechIds")
        .and_then(Value::as_array)
        .is_none()
        || ["rocketsLaunched", "whiteMatrixProduced"]
            .iter()
            .any(|key| {
                baseline
                    .get(*key)
                    .and_then(Value::as_f64)
                    .is_none_or(|value| !value.is_finite() || value < 0.0)
            })
        || speedrun
            .get("milestones")
            .and_then(Value::as_object)
            .is_none()
    {
        return Ok(Some("speedrun-state-invalid"));
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn technology_progress_excludes_baseline_and_deprecated_ids_without_a_catalog_set() {
        let ids = [
            "baseline-tech".to_owned(),
            "current-tech".to_owned(),
            "pending-tech".to_owned(),
            "orbital_elevator_engineering".to_owned(),
        ];
        let completed = HashSet::from(["baseline-tech", "current-tech", "unknown-tech"]);
        let baseline = HashSet::from(["baseline-tech"]);

        assert_eq!(
            finite_technology_progress(ids.iter(), &completed, &baseline),
            (2, 1)
        );
    }
}
