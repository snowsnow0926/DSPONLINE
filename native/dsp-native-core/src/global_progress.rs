use std::collections::HashMap;

use anyhow::{anyhow, bail};
use serde_json::{Map, Number, Value};

use crate::catalog::RecipeDefinition;
use crate::state::CoreState;

const EPSILON: f64 = 0.0001;
const DEFAULT_TRAY_LIMIT: f64 = 1_000_000.0;
const MIN_TRAY_LIMIT: f64 = 1_000.0;
const MAX_TRAY_LIMIT: f64 = 100_000_000.0;

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
            .ok_or_else(|| anyhow!("native global progression produced a non-finite number"))?,
    );
    Ok(())
}

fn rounded(value: f64, digits: i32) -> f64 {
    let scale = 10_f64.powi(digits);
    (value * scale).round() / scale
}

fn active_planet(base: &Map<String, Value>) -> anyhow::Result<&str> {
    base.get("activePlanetId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("native global progression active planet is missing"))
}

fn tray_limit(base: &Map<String, Value>, planet_id: &str) -> f64 {
    base.get("planetTrayItemLimits")
        .and_then(Value::as_object)
        .and_then(|limits| limits.get(planet_id))
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .map(|value| value.floor().clamp(MIN_TRAY_LIMIT, MAX_TRAY_LIMIT))
        .unwrap_or(DEFAULT_TRAY_LIMIT)
}

fn is_portable_fleet_item(item_id: &str) -> bool {
    matches!(item_id, "logistics_drone" | "logistics_vessel")
}

fn can_store_outputs(base: &Map<String, Value>, recipe: &RecipeDefinition) -> anyhow::Result<bool> {
    let planet_id = active_planet(base)?;
    let limit = tray_limit(base, planet_id);
    let tray = base
        .get("tray")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native handcraft tray is missing"))?;
    let mut required = HashMap::<&str, f64>::new();
    for output in &recipe.outputs {
        *required.entry(&output.item_id).or_default() += output.amount;
    }
    Ok(required.into_iter().all(|(item_id, amount)| {
        is_portable_fleet_item(item_id)
            || limit - finite_number(tray.get(item_id)).floor() + EPSILON >= amount
    }))
}

fn has_inputs(base: &Map<String, Value>, recipe: &RecipeDefinition) -> anyhow::Result<bool> {
    let tray = base
        .get("tray")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native handcraft tray is missing"))?;
    Ok(recipe
        .inputs
        .iter()
        .all(|input| finite_number(tray.get(&input.item_id)) + EPSILON >= input.amount))
}

fn consume_inputs(base: &mut Map<String, Value>, recipe: &RecipeDefinition) -> anyhow::Result<()> {
    let tray = base
        .get_mut("tray")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native handcraft tray is missing"))?;
    for input in &recipe.inputs {
        let current = finite_number(tray.get(&input.item_id));
        set_number(
            tray,
            &input.item_id,
            (current - input.amount).floor().max(0.0),
        )?;
    }
    Ok(())
}

fn add_output(base: &mut Map<String, Value>, item_id: &str, amount: f64) -> anyhow::Result<()> {
    if is_portable_fleet_item(item_id) {
        let fleet = base
            .get_mut("portableFleet")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native portable fleet inventory is missing"))?;
        let current = finite_number(fleet.get(item_id));
        return set_number(fleet, item_id, (current + amount + EPSILON).floor());
    }
    let tray = base
        .get_mut("tray")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native handcraft tray is missing"))?;
    let current = finite_number(tray.get(item_id));
    set_number(tray, item_id, (current + amount + EPSILON).floor())
}

fn record_produced(
    base: &mut Map<String, Value>,
    item_id: &str,
    amount: f64,
) -> anyhow::Result<()> {
    let produced = base
        .get_mut("totalProduced")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native total-produced state is missing"))?;
    let current = finite_number(produced.get(item_id));
    set_number(produced, item_id, (current + amount).floor())
}

pub(crate) fn advance_handcraft(
    state: &CoreState,
    base: &mut Map<String, Value>,
    seconds: f64,
) -> anyhow::Result<()> {
    let mut queue = std::mem::take(
        base.get_mut("handcraftQueue")
            .and_then(Value::as_array_mut)
            .ok_or_else(|| anyhow!("native handcraft queue is missing"))?,
    );
    let active_planet = active_planet(base)?.to_owned();
    let mut remaining_seconds = seconds.max(0.0);
    while remaining_seconds > EPSILON && !queue.is_empty() {
        let entry = queue[0]
            .as_object()
            .ok_or_else(|| anyhow!("native handcraft entry is invalid"))?;
        if entry.get("planetId").and_then(Value::as_str) != Some(&active_planet) {
            break;
        }
        let recipe_id = entry
            .get("recipeId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let Some(recipe) = state.catalog.recipes.get(recipe_id).cloned() else {
            queue.remove(0);
            continue;
        };
        if recipe.outputs.is_empty() {
            queue.remove(0);
            continue;
        }
        let duration = recipe.duration.max(0.05);
        let progress = finite_number(entry.get("progress"));
        if progress <= EPSILON {
            if !can_store_outputs(base, &recipe)? || !has_inputs(base, &recipe)? {
                break;
            }
            consume_inputs(base, &recipe)?;
        }
        let cycle_remaining = ((1.0 - progress) * duration).max(0.0);
        let elapsed = remaining_seconds.min(cycle_remaining);
        let next_progress = (progress + elapsed / duration).min(1.0);
        remaining_seconds -= elapsed;
        set_number(
            queue[0]
                .as_object_mut()
                .ok_or_else(|| anyhow!("native handcraft entry is invalid"))?,
            "progress",
            next_progress,
        )?;
        if next_progress < 1.0 - EPSILON {
            break;
        }
        if !can_store_outputs(base, &recipe)? {
            break;
        }
        for output in &recipe.outputs {
            add_output(base, &output.item_id, output.amount)?;
            record_produced(base, &output.item_id, output.amount)?;
        }
        let entry = queue[0]
            .as_object_mut()
            .ok_or_else(|| anyhow!("native handcraft entry is invalid"))?;
        let batches_remaining = finite_number(entry.get("batchesRemaining")) - 1.0;
        set_number(entry, "batchesRemaining", batches_remaining)?;
        set_number(entry, "progress", 0.0)?;
        if batches_remaining <= 0.0 {
            queue.remove(0);
        }
    }
    base.insert("handcraftQueue".to_owned(), Value::Array(queue));
    Ok(())
}

pub(crate) fn advance_exploration(
    state: &CoreState,
    base: &mut Map<String, Value>,
    seconds: f64,
) -> anyhow::Result<()> {
    let exploration = base
        .get_mut("exploration")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native exploration state is missing"))?;
    let missions = std::mem::take(
        exploration
            .get_mut("missions")
            .and_then(Value::as_array_mut)
            .ok_or_else(|| anyhow!("native exploration missions are missing"))?,
    );
    let mut remaining = Vec::with_capacity(missions.len());
    for mut mission in missions {
        let object = mission
            .as_object_mut()
            .ok_or_else(|| anyhow!("native exploration mission is invalid"))?;
        let system_id = object
            .get("systemId")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("native exploration system ID is missing"))?
            .to_owned();
        let duration = finite_number(object.get("durationSeconds"));
        let elapsed = duration.min(finite_number(object.get("elapsedSeconds")) + seconds);
        let progress = if duration <= EPSILON {
            1.0
        } else {
            elapsed / duration
        };
        let survey = exploration
            .get_mut("surveyProgressBySystem")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native exploration survey progress is missing"))?;
        set_number(survey, &system_id, rounded(progress, 4))?;
        if progress + EPSILON >= 1.0 {
            let unlocked = exploration
                .get_mut("unlockedSystemIds")
                .and_then(Value::as_array_mut)
                .ok_or_else(|| anyhow!("native unlocked systems are missing"))?;
            if !unlocked
                .iter()
                .any(|value| value.as_str() == Some(&system_id))
            {
                unlocked.push(Value::from(system_id.clone()));
            }
            let pioneer = state
                .catalog
                .planets
                .iter()
                .filter(|planet| planet.system_id == system_id)
                .min_by_key(|planet| planet.simulation_order)
                .map(|planet| planet.id.clone())
                .ok_or_else(|| anyhow!("native exploration system is not in the catalog"))?;
            let colonized = exploration
                .get_mut("colonizedPlanetIds")
                .and_then(Value::as_array_mut)
                .ok_or_else(|| anyhow!("native colonized planets are missing"))?;
            if !colonized
                .iter()
                .any(|value| value.as_str() == Some(&pioneer))
            {
                colonized.push(Value::from(pioneer));
            }
        } else {
            set_number(object, "elapsedSeconds", elapsed)?;
            remaining.push(mission);
        }
    }
    exploration.insert("missions".to_owned(), Value::Array(remaining));
    Ok(())
}

pub(crate) fn admission_reason(state: &CoreState) -> anyhow::Result<Option<&'static str>> {
    let base = state.base_value();
    let queue = base
        .get("handcraftQueue")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("native handcraft queue is missing"))?;
    for entry in queue {
        let object = entry
            .as_object()
            .ok_or_else(|| anyhow!("native handcraft entry is invalid"))?;
        for key in ["batchesTotal", "batchesRemaining", "progress", "queuedAt"] {
            if object
                .get(key)
                .and_then(Value::as_f64)
                .is_none_or(|value| !value.is_finite())
            {
                return Ok(Some("handcraft-queue-invalid"));
            }
        }
        if object.get("id").and_then(Value::as_str).is_none()
            || object.get("recipeId").and_then(Value::as_str).is_none()
            || object.get("planetId").and_then(Value::as_str).is_none()
        {
            return Ok(Some("handcraft-queue-invalid"));
        }
    }
    let exploration = base
        .get("exploration")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native exploration state is missing"))?;
    let missions = exploration
        .get("missions")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("native exploration missions are missing"))?;
    for mission in missions {
        let object = mission
            .as_object()
            .ok_or_else(|| anyhow!("native exploration mission is invalid"))?;
        let Some(system_id) = object.get("systemId").and_then(Value::as_str) else {
            return Ok(Some("exploration-mission-invalid"));
        };
        if !state
            .catalog
            .planets
            .iter()
            .any(|planet| planet.system_id == system_id)
            || ["elapsedSeconds", "durationSeconds"].iter().any(|key| {
                object
                    .get(*key)
                    .and_then(Value::as_f64)
                    .is_none_or(|value| !value.is_finite() || value < 0.0)
            })
        {
            return Ok(Some("exploration-mission-invalid"));
        }
    }
    for key in ["unlockedSystemIds", "colonizedPlanetIds"] {
        if exploration.get(key).and_then(Value::as_array).is_none() {
            bail!("native exploration list is missing");
        }
    }
    if exploration
        .get("surveyProgressBySystem")
        .and_then(Value::as_object)
        .is_none()
    {
        bail!("native exploration survey progress is missing");
    }
    Ok(None)
}
