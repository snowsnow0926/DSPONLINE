use std::cmp::Ordering;
use std::collections::HashMap;

use anyhow::anyhow;
use serde_json::{Map, Number, Value};

use crate::state::CoreState;

const EPSILON: f64 = 0.0001;

#[derive(Clone, Copy)]
struct Definition {
    id: &'static str,
    item_id: &'static str,
    base_target: f64,
    target_growth: f64,
    credits_per_item: f64,
    base_rate_per_minute: f64,
    reserve: f64,
}

const DEFINITIONS: [Definition; 4] = [
    Definition {
        id: "universe_archive",
        item_id: "universe_matrix",
        base_target: 1_000.0,
        target_growth: 1.55,
        credits_per_item: 12.0,
        base_rate_per_minute: 120.0,
        reserve: 120.0,
    },
    Definition {
        id: "solar_sail_array",
        item_id: "solar_sail",
        base_target: 5_000.0,
        target_growth: 1.5,
        credits_per_item: 3.0,
        base_rate_per_minute: 360.0,
        reserve: 240.0,
    },
    Definition {
        id: "carrier_rocket_fleet",
        item_id: "small_carrier_rocket",
        base_target: 1_000.0,
        target_growth: 1.52,
        credits_per_item: 24.0,
        base_rate_per_minute: 60.0,
        reserve: 60.0,
    },
    Definition {
        id: "antimatter_exchange",
        item_id: "antimatter_fuel_rod",
        base_target: 500.0,
        target_growth: 1.58,
        credits_per_item: 80.0,
        base_rate_per_minute: 30.0,
        reserve: 24.0,
    },
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
            .ok_or_else(|| anyhow!("native galactic export produced a non-finite number"))?,
    );
    Ok(())
}

fn completed_tech(base: &Map<String, Value>, id: &str) -> bool {
    base.get("research")
        .and_then(Value::as_object)
        .and_then(|research| research.get("completedTechIds"))
        .and_then(Value::as_array)
        .is_some_and(|ids| ids.iter().any(|value| value.as_str() == Some(id)))
}

fn target(definition: Definition, level: f64) -> f64 {
    (definition.base_target * definition.target_growth.powf(level.floor().max(0.0)))
        .round()
        .clamp(1.0, 2_000_000_000.0)
}

fn reward(definition: Definition, level: f64) -> f64 {
    (target(definition, level) * definition.credits_per_item)
        .floor()
        .max(1.0)
}

fn project<'a>(
    endgame: &'a mut Map<String, Value>,
    id: &str,
) -> anyhow::Result<&'a mut Map<String, Value>> {
    endgame
        .get_mut("exportProjects")
        .and_then(Value::as_object_mut)
        .and_then(|projects| projects.get_mut(id))
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native galactic export project is missing"))
}

fn complete_levels(endgame: &mut Map<String, Value>, definition: Definition) -> anyhow::Result<()> {
    loop {
        let (delivered, level) = {
            let project = project(endgame, definition.id)?;
            (
                finite_number(project.get("delivered")),
                finite_number(project.get("level")),
            )
        };
        let required = target(definition, level);
        if delivered < required {
            return Ok(());
        }
        {
            let project = project(endgame, definition.id)?;
            set_number(project, "delivered", delivered - required)?;
            set_number(project, "level", level + 1.0)?;
        }
        let earned = reward(definition, level);
        for key in ["galacticCredits", "galacticScore"] {
            let current = finite_number(endgame.get(key));
            set_number(endgame, key, (current + earned).floor())?;
        }
    }
}

fn record_activity_delivery(
    endgame: &mut Map<String, Value>,
    definition: Definition,
    shipped: f64,
) -> anyhow::Result<()> {
    let activity = endgame
        .get_mut("constructionActivity")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native galactic construction activity is missing"))?;
    let activity_id = activity
        .get("activityId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let participant_id = activity
        .get("participantId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    if activity_id.is_empty() || participant_id.is_empty() {
        return Ok(());
    }
    let clock = finite_number(activity.get("activityClockMs"));
    let personal = activity
        .get_mut("personalDelivered")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native personal export delivery state is missing"))?;
    let personal_total = finite_number(personal.get(definition.item_id));
    set_number(
        personal,
        definition.item_id,
        (personal_total + shipped).floor(),
    )?;
    let existing = activity
        .get_mut("pendingBatches")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native pending export batches are missing"))?
        .get_mut(definition.item_id)
        .and_then(Value::as_object_mut);
    if let Some(batch) = existing {
        let amount = finite_number(batch.get("amount"));
        set_number(batch, "amount", (amount + shipped).floor())?;
        set_number(batch, "lastDeliveredAtMs", clock)?;
        return Ok(());
    }
    let sequence = finite_number(activity.get("nextBatchSequence"));
    set_number(activity, "nextBatchSequence", sequence + 1.0)?;
    let sequence_label = if sequence.fract().abs() <= f64::EPSILON {
        format!("{:.0}", sequence)
    } else {
        sequence.to_string()
    };
    let batch = serde_json::json!({
        "id": format!("{activity_id}:{participant_id}:{}:{sequence_label}", definition.item_id),
        "itemId": definition.item_id,
        "amount": shipped,
        "sequence": sequence,
        "firstDeliveredAtMs": clock,
        "lastDeliveredAtMs": clock,
    });
    activity
        .get_mut("pendingBatches")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native pending export batches are missing"))?
        .insert(definition.item_id.to_owned(), batch);
    Ok(())
}

fn record_delivery(
    endgame: &mut Map<String, Value>,
    definition: Definition,
    amount: f64,
    activity_eligible: bool,
) -> anyhow::Result<()> {
    let shipped = amount.floor().max(0.0);
    if shipped < 1.0 {
        return Ok(());
    }
    {
        let project = project(endgame, definition.id)?;
        for key in ["delivered", "totalDelivered"] {
            let current = finite_number(project.get(key));
            set_number(project, key, current + shipped)?;
        }
    }
    for key in ["totalExported", "exportWindowAmount"] {
        let current = finite_number(endgame.get(key));
        set_number(endgame, key, current + shipped)?;
    }
    let earned = shipped * definition.credits_per_item;
    for key in ["galacticCredits", "galacticScore"] {
        let current = finite_number(endgame.get(key));
        set_number(endgame, key, (current + earned).floor())?;
    }
    complete_levels(endgame, definition)?;
    if activity_eligible {
        record_activity_delivery(endgame, definition, shipped)?;
    }
    Ok(())
}

fn network_stock(
    state: &CoreState,
    base: &Map<String, Value>,
    entities: &[Value],
    item_id: &str,
) -> f64 {
    let active_planet = base
        .get("activePlanetId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let tray = base.get("tray").and_then(Value::as_object);
    let trays = base.get("planetTrays").and_then(Value::as_object);
    let tray_total = state
        .catalog
        .planets
        .iter()
        .map(|planet| {
            if planet.id == active_planet {
                finite_number(tray.and_then(|tray| tray.get(item_id))).floor()
            } else {
                finite_number(
                    trays
                        .and_then(|trays| trays.get(&planet.id))
                        .and_then(Value::as_object)
                        .and_then(|tray| tray.get(item_id)),
                )
                .floor()
            }
        })
        .sum::<f64>();
    let entity_total = entities
        .iter()
        .filter_map(Value::as_object)
        .map(|entity| {
            finite_number(
                entity
                    .get("outputs")
                    .and_then(Value::as_object)
                    .and_then(|outputs| outputs.get(item_id)),
            )
            .floor()
        })
        .sum::<f64>();
    (tray_total + entity_total).max(0.0)
}

fn withdraw(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entities: &mut [Value],
    item_id: &str,
    amount: f64,
) -> anyhow::Result<f64> {
    let mut remaining = amount.floor().max(0.0);
    let mut withdrawn = 0.0;
    for entity in entities.iter_mut().filter_map(Value::as_object_mut) {
        if remaining < 1.0 {
            break;
        }
        let outputs = entity
            .get_mut("outputs")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native export entity outputs are missing"))?;
        let available = finite_number(outputs.get(item_id)).floor().max(0.0);
        let taken = remaining.min(available);
        if taken < 1.0 {
            continue;
        }
        set_number(outputs, item_id, available - taken)?;
        remaining -= taken;
        withdrawn += taken;
    }
    let active_planet = base
        .get("activePlanetId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("native export active planet is missing"))?
        .to_owned();
    for planet in &state.catalog.planets {
        if remaining < 1.0 {
            break;
        }
        let tray = if planet.id == active_planet {
            base.get_mut("tray")
                .and_then(Value::as_object_mut)
                .ok_or_else(|| anyhow!("native export active tray is missing"))?
        } else {
            base.get_mut("planetTrays")
                .and_then(Value::as_object_mut)
                .and_then(|trays| trays.get_mut(&planet.id))
                .and_then(Value::as_object_mut)
                .ok_or_else(|| anyhow!("native export planet tray is missing"))?
        };
        let available = finite_number(tray.get(item_id)).floor().max(0.0);
        let taken = remaining.min(available);
        if taken < 1.0 {
            continue;
        }
        set_number(tray, item_id, available - taken)?;
        remaining -= taken;
        withdrawn += taken;
    }
    let active_tray = base
        .get("tray")
        .cloned()
        .ok_or_else(|| anyhow!("native export active tray is missing"))?;
    base.get_mut("planetTrays")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native export planet trays are missing"))?
        .insert(active_planet, active_tray);
    Ok(withdrawn)
}

fn dispatch(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entities: &mut [Value],
    endgame: &mut Map<String, Value>,
    definition: Definition,
    requested: f64,
) -> anyhow::Result<f64> {
    if !completed_tech(base, "universe_matrix") {
        return Ok(0.0);
    }
    let level = finite_number(project(endgame, definition.id)?.get("level"));
    let reserve = (definition.reserve * (1.0 + level * 0.08)).floor();
    let available = (network_stock(state, base, entities, definition.item_id) - reserve).max(0.0);
    let shipped = withdraw(
        state,
        base,
        entities,
        definition.item_id,
        available.min(requested),
    )?;
    if shipped > 0.0 {
        record_delivery(endgame, definition, shipped, false)?;
    }
    Ok(shipped)
}

fn activity_active(endgame: &Map<String, Value>) -> bool {
    let Some(activity) = endgame
        .get("constructionActivity")
        .and_then(Value::as_object)
    else {
        return false;
    };
    let active = activity
        .get("activityId")
        .and_then(Value::as_str)
        .is_some_and(|id| !id.is_empty());
    let clock = finite_number(activity.get("activityClockMs"));
    active
        && clock >= finite_number(activity.get("startsAtMs"))
        && clock < finite_number(activity.get("endsAtMs"))
}

pub(crate) fn ready_exporter_indices(state: &CoreState, entities: &[Value]) -> Vec<usize> {
    state
        .factory_topology
        .galactic_material_exporter_indices
        .iter()
        .copied()
        .filter(|&index| {
            let Some(entity) = entities.get(index).and_then(Value::as_object) else {
                return false;
            };
            entity
                .get("galacticExporterPaused")
                .and_then(Value::as_bool)
                == Some(false)
                && DEFINITIONS.iter().any(|definition| {
                    finite_number(
                        entity
                            .get("inputs")
                            .and_then(Value::as_object)
                            .and_then(|inputs| inputs.get(definition.item_id)),
                    ) >= 1.0
                })
        })
        .collect()
}

pub(crate) fn operating_blocked(entity: &Map<String, Value>) -> bool {
    if entity
        .get("galacticExporterPaused")
        .and_then(Value::as_bool)
        != Some(false)
    {
        return false;
    }
    let buffered = DEFINITIONS
        .iter()
        .map(|definition| {
            finite_number(
                entity
                    .get("inputs")
                    .and_then(Value::as_object)
                    .and_then(|inputs| inputs.get(definition.item_id)),
            )
            .max(0.0)
        })
        .sum::<f64>();
    buffered >= 1.0 && finite_number(entity.get("powerFactor")) <= EPSILON
}

pub(crate) fn run(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entities: &mut [Value],
    effective_power: &HashMap<usize, f64>,
    allocated_power: &HashMap<usize, f64>,
    seconds: f64,
) -> anyhow::Result<()> {
    let mut endgame = base
        .remove("endgame")
        .and_then(|value| value.as_object().cloned())
        .ok_or_else(|| anyhow!("native galactic endgame state is missing"))?;
    let physical_active = activity_active(&endgame);
    for &index in &state.factory_topology.galactic_material_exporter_indices {
        let entity = entities
            .get_mut(index)
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native galactic exporter is invalid"))?;
        let power = effective_power.get(&index).copied().unwrap_or(0.0);
        if allocated_power.contains_key(&index) {
            set_number(entity, "powerFactor", (power * 10_000.0).round() / 10_000.0)?;
        } else {
            entity.remove("powerFactor");
        }
        set_number(entity, "productionRate", 0.0)?;
        set_number(entity, "utilization", 0.0)?;
        if !physical_active
            || entity
                .get("galacticExporterPaused")
                .and_then(Value::as_bool)
                != Some(false)
            || power <= EPSILON
        {
            continue;
        }
        let mut ordered = DEFINITIONS;
        ordered.sort_by(|left, right| {
            let priority = |definition: Definition| {
                endgame
                    .get("exportProjects")
                    .and_then(Value::as_object)
                    .and_then(|projects| projects.get(definition.id))
                    .and_then(Value::as_object)
                    .map(|project| finite_number(project.get("priority")))
                    .unwrap_or(0.0)
            };
            priority(*right)
                .partial_cmp(&priority(*left))
                .unwrap_or(Ordering::Equal)
                .then_with(|| left.item_id.cmp(right.item_id))
        });
        let mut delivered = 0.0;
        for definition in ordered {
            let amount = entity
                .get("inputs")
                .and_then(Value::as_object)
                .map(|inputs| {
                    finite_number(inputs.get(definition.item_id))
                        .floor()
                        .max(0.0)
                })
                .unwrap_or(0.0);
            if amount < 1.0 {
                continue;
            }
            entity
                .get_mut("inputs")
                .and_then(Value::as_object_mut)
                .ok_or_else(|| anyhow!("native galactic exporter inputs are missing"))?
                .insert(definition.item_id.to_owned(), Value::from(0));
            record_delivery(&mut endgame, definition, amount, true)?;
            delivered += amount;
        }
        set_number(
            entity,
            "utilization",
            if delivered > 0.0 { power } else { 0.0 },
        )?;
        set_number(entity, "productionRate", delivered * 60.0)?;
    }

    if completed_tech(base, "universe_matrix")
        && endgame.get("exportInputMode").and_then(Value::as_str) == Some("legacy-network")
        && endgame.get("autoDispatch").and_then(Value::as_bool) == Some(true)
        && seconds > EPSILON
    {
        let mut enabled = DEFINITIONS
            .iter()
            .copied()
            .filter(|definition| {
                endgame
                    .get("exportProjects")
                    .and_then(Value::as_object)
                    .and_then(|projects| projects.get(definition.id))
                    .and_then(Value::as_object)
                    .and_then(|project| project.get("enabled"))
                    .and_then(Value::as_bool)
                    == Some(true)
            })
            .collect::<Vec<_>>();
        enabled.sort_by(|left, right| {
            let priority = |definition: Definition| {
                endgame
                    .get("exportProjects")
                    .and_then(Value::as_object)
                    .and_then(|projects| projects.get(definition.id))
                    .and_then(Value::as_object)
                    .map(|project| finite_number(project.get("priority")))
                    .unwrap_or(0.0)
            };
            priority(*right)
                .partial_cmp(&priority(*left))
                .unwrap_or(Ordering::Equal)
                .then_with(|| left.id.cmp(right.id))
        });
        let logistics_level = endgame
            .get("infiniteResearch")
            .and_then(Value::as_object)
            .and_then(|research| research.get("galactic_logistics"))
            .and_then(Value::as_object)
            .map(|progress| finite_number(progress.get("level")))
            .unwrap_or(0.0);
        let throttle = finite_number(endgame.get("dispatchThrottle"));
        for definition in enabled {
            let rate = definition.base_rate_per_minute * throttle * (1.0 + logistics_level * 0.1);
            let previous =
                finite_number(project(&mut endgame, definition.id)?.get("dispatchProgress"));
            let progress = (previous.max(0.0) + rate * seconds / 60.0).min(rate * 2.0);
            set_number(
                project(&mut endgame, definition.id)?,
                "dispatchProgress",
                progress,
            )?;
            let requested = (progress + EPSILON).floor();
            if requested < 1.0 {
                continue;
            }
            let shipped = dispatch(state, base, entities, &mut endgame, definition, requested)?;
            set_number(
                project(&mut endgame, definition.id)?,
                "dispatchProgress",
                if shipped >= requested {
                    progress - requested
                } else {
                    0.0
                },
            )?;
        }
    }
    base.insert("endgame".to_owned(), Value::Object(endgame));
    Ok(())
}

pub(crate) fn admission_reason(state: &CoreState) -> anyhow::Result<Option<&'static str>> {
    let base = state.base_value();
    let endgame = base
        .get("endgame")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native galactic endgame state is missing"))?;
    if !matches!(
        endgame.get("exportInputMode").and_then(Value::as_str),
        Some("building" | "legacy-network")
    ) {
        return Ok(Some("galactic-export-mode-invalid"));
    }
    let projects = endgame
        .get("exportProjects")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native galactic export projects are missing"))?;
    for definition in DEFINITIONS {
        let Some(project) = projects.get(definition.id).and_then(Value::as_object) else {
            return Ok(Some("galactic-export-project-invalid"));
        };
        if project.get("enabled").and_then(Value::as_bool).is_none()
            || !matches!(
                project.get("priority").and_then(Value::as_f64),
                Some(1.0 | 2.0 | 3.0)
            )
            || ["level", "delivered", "totalDelivered", "dispatchProgress"]
                .iter()
                .any(|key| {
                    project
                        .get(*key)
                        .and_then(Value::as_f64)
                        .is_none_or(|value| !value.is_finite() || value < 0.0)
                })
        {
            return Ok(Some("galactic-export-project-invalid"));
        }
    }
    Ok(None)
}
