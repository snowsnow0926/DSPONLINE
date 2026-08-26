use std::collections::HashMap;

use anyhow::{anyhow, bail};
use serde_json::{Map, Number, Value, json};

use crate::state::CoreState;

const EPSILON: f64 = 0.0001;
const SOLAR_SAIL_POWER_KW: f64 = 88.0;
const SOLAR_SAIL_LIFETIME_SECONDS: f64 = 1_200.0;
const RAY_RECEIVER_CAPACITY_KW: f64 = 6_000.0;
const DYSON_STRUCTURE_POWER_KW: f64 = 960.0;
const DYSON_SHELL_SAIL_POWER_KW: f64 = 88.0;
const DYSON_SHELL_CAPACITY_PER_STRUCTURE: f64 = 40.0;
const DYSON_SAIL_ABSORPTION_PER_STRUCTURE_PER_SECOND: f64 = 0.1;
const DYSON_SAIL_LAUNCH_ENERGY_MJ: f64 = 21.6;
const DYSON_ROCKET_LAUNCH_ENERGY_MJ: f64 = 108.0;
const SYSTEM_IDS: [&str; 8] = [
    "helios",
    "borealis",
    "aurora",
    "ember",
    "sirius",
    "white_dwarf",
    "neutron",
    "blue_giant",
];

#[derive(Debug, Clone, Default)]
pub(crate) struct Reception {
    pub allocation_by_entity: HashMap<String, f64>,
    pub efficiency_by_entity: HashMap<String, f64>,
    pub ray_power_by_entity: HashMap<String, f64>,
}

#[derive(Debug, Clone)]
struct DysonState {
    swarm: Map<String, Value>,
    sphere: Map<String, Value>,
    engineering: Map<String, Value>,
    plans: Map<String, Value>,
}

fn finite(value: Option<&Value>) -> f64 {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .unwrap_or(0.0)
}

fn text<'a>(object: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    object.get(key).and_then(Value::as_str)
}

fn rounded(value: f64, digits: i32) -> f64 {
    let scale = 10_f64.powi(digits);
    (value * scale).round() / scale
}

fn set_number(object: &mut Map<String, Value>, key: &str, value: f64) -> anyhow::Result<()> {
    object.insert(
        key.to_owned(),
        Number::from_f64(value)
            .map(Value::Number)
            .ok_or_else(|| anyhow!("native Dyson simulation produced a non-finite number"))?,
    );
    Ok(())
}

fn load(base: &Map<String, Value>) -> anyhow::Result<DysonState> {
    let object = |key: &str| {
        base.get(key)
            .and_then(Value::as_object)
            .cloned()
            .ok_or_else(|| anyhow!("native Dyson {key} state is missing"))
    };
    Ok(DysonState {
        swarm: object("dysonSwarm")?,
        sphere: object("dysonSphere")?,
        engineering: object("dysonEngineering")?,
        plans: object("dysonPlans")?,
    })
}

fn save(base: &mut Map<String, Value>, state: DysonState) {
    base.insert("dysonSwarm".to_owned(), Value::Object(state.swarm));
    base.insert("dysonSphere".to_owned(), Value::Object(state.sphere));
    base.insert(
        "dysonEngineering".to_owned(),
        Value::Object(state.engineering),
    );
    base.insert("dysonPlans".to_owned(), Value::Object(state.plans));
}

fn completed(base: &Map<String, Value>, tech_id: &str) -> bool {
    base.get("research")
        .and_then(Value::as_object)
        .and_then(|research| research.get("completedTechIds"))
        .and_then(Value::as_array)
        .is_some_and(|ids| ids.iter().any(|id| id.as_str() == Some(tech_id)))
}

fn infinite_level(base: &Map<String, Value>, id: &str) -> f64 {
    base.get("endgame")
        .and_then(Value::as_object)
        .and_then(|endgame| endgame.get("infiniteResearch"))
        .and_then(Value::as_object)
        .and_then(|research| research.get(id))
        .and_then(Value::as_object)
        .and_then(|progress| progress.get("level"))
        .map(|level| finite(Some(level)).floor().max(0.0))
        .unwrap_or(0.0)
}

fn power_multiplier(base: &Map<String, Value>) -> f64 {
    1.0 + infinite_level(base, "stellar_harnessing") * 0.05
}

fn absorption_multiplier(base: &Map<String, Value>) -> f64 {
    (if completed(base, "dyson_absorption_1") {
        2.0
    } else {
        1.0
    }) * power_multiplier(base)
}

fn sail_lifetime(base: &Map<String, Value>) -> f64 {
    SOLAR_SAIL_LIFETIME_SECONDS
        * (1.0
            + if completed(base, "solar_sail_life_1") {
                0.5
            } else {
                0.0
            }
            + if completed(base, "solar_sail_life_2") {
                0.5
            } else {
                0.0
            })
}

fn luminosity(base: &Map<String, Value>, system_id: &str) -> f64 {
    base.get("galaxy")
        .and_then(Value::as_object)
        .and_then(|galaxy| galaxy.get("systemProfiles"))
        .and_then(Value::as_object)
        .and_then(|profiles| profiles.get(system_id))
        .and_then(Value::as_object)
        .and_then(|profile| profile.get("luminosity"))
        .map(|value| finite(Some(value)).max(0.01))
        .unwrap_or(1.0)
}

fn sail_power(base: &Map<String, Value>, system_id: &str) -> f64 {
    SOLAR_SAIL_POWER_KW * power_multiplier(base) * luminosity(base, system_id)
}

fn system_for_planet<'a>(state: &'a CoreState, planet_id: &str) -> Option<&'a str> {
    state
        .catalog
        .planets
        .iter()
        .find(|planet| planet.id == planet_id)
        .map(|planet| planet.system_id.as_str())
}

fn orbits_by_system_mut(state: &mut DysonState) -> anyhow::Result<&mut Map<String, Value>> {
    state
        .engineering
        .get_mut("orbitsBySystem")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native Dyson orbit directory is missing"))
}

fn orbits_for<'a>(state: &'a DysonState, system_id: &str) -> &'a [Value] {
    state
        .engineering
        .get("orbitsBySystem")
        .and_then(Value::as_object)
        .and_then(|systems| systems.get(system_id))
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn orbits_for_mut<'a>(
    state: &'a mut DysonState,
    system_id: &str,
) -> anyhow::Result<&'a mut Vec<Value>> {
    orbits_by_system_mut(state)?
        .get_mut(system_id)
        .and_then(Value::as_array_mut)
        .ok_or_else(|| anyhow!("native Dyson orbit system is missing: {system_id}"))
}

fn default_orbit(system_id: &str) -> Value {
    json!({
        "id": format!("dyson_orbit_{system_id}_1"),
        "name": "太阳帆轨道 A",
        "radius": 50_000,
        "inclination": 0,
        "longitude": 0,
        "sailsInOrbit": 0,
        "totalLaunched": 0,
        "totalExpired": 0,
        "decayProgress": 0,
        "generationKw": 0,
    })
}

fn ensure_orbit(state: &mut DysonState, system_id: &str) -> anyhow::Result<String> {
    let active_id = state
        .engineering
        .get("activeOrbitBySystem")
        .and_then(Value::as_object)
        .and_then(|active| active.get(system_id))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let orbits = orbits_for_mut(state, system_id)?;
    let selected = active_id
        .as_deref()
        .and_then(|id| {
            orbits
                .iter()
                .filter_map(Value::as_object)
                .find(|orbit| text(orbit, "id") == Some(id))
                .and_then(|orbit| text(orbit, "id"))
                .map(str::to_owned)
        })
        .or_else(|| {
            orbits
                .first()
                .and_then(Value::as_object)
                .and_then(|orbit| text(orbit, "id"))
                .map(str::to_owned)
        })
        .unwrap_or_else(|| {
            orbits.push(default_orbit(system_id));
            format!("dyson_orbit_{system_id}_1")
        });
    state
        .engineering
        .get_mut("activeOrbitBySystem")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native Dyson active orbit directory is missing"))?
        .insert(system_id.to_owned(), Value::from(selected.clone()));
    Ok(selected)
}

fn orbit_total(state: &DysonState, field: &str) -> f64 {
    SYSTEM_IDS
        .iter()
        .flat_map(|system_id| orbits_for(state, system_id))
        .filter_map(Value::as_object)
        .map(|orbit| finite(orbit.get(field)).max(0.0))
        .sum()
}

fn adjust_orbit_aggregate(state: &mut DysonState, field: &str) -> anyhow::Result<()> {
    let current = orbit_total(state, field).floor();
    let requested = finite(state.swarm.get(field)).floor().max(0.0);
    let delta = requested - current;
    if delta > 0.0 {
        let active = ensure_orbit(state, "helios")?;
        let orbit = orbits_for_mut(state, "helios")?
            .iter_mut()
            .filter_map(Value::as_object_mut)
            .find(|orbit| text(orbit, "id") == Some(active.as_str()))
            .ok_or_else(|| anyhow!("native Dyson Helios orbit disappeared"))?;
        let value = finite(orbit.get(field));
        set_number(orbit, field, (value + delta).floor().max(0.0))?;
    } else if delta < 0.0 {
        let mut remaining = -delta;
        for system_id in SYSTEM_IDS.iter().rev() {
            for orbit in orbits_for_mut(state, system_id)?
                .iter_mut()
                .rev()
                .filter_map(Value::as_object_mut)
            {
                let value = finite(orbit.get(field)).floor().max(0.0);
                let removed = value.min(remaining);
                set_number(orbit, field, value - removed)?;
                remaining -= removed;
                if remaining <= 0.0 {
                    return Ok(());
                }
            }
        }
    }
    Ok(())
}

fn aggregate_swarm(state: &mut DysonState) -> anyhow::Result<()> {
    let sails = orbit_total(state, "sailsInOrbit").floor();
    let launched = orbit_total(state, "totalLaunched").floor();
    let expired = orbit_total(state, "totalExpired").floor();
    let progress = SYSTEM_IDS
        .iter()
        .flat_map(|system_id| orbits_for(state, system_id))
        .filter_map(Value::as_object)
        .map(|orbit| finite(orbit.get("decayProgress")).max(0.0))
        .sum::<f64>();
    let generation = orbit_total(state, "generationKw").floor();
    set_number(&mut state.swarm, "sailsInOrbit", sails)?;
    set_number(&mut state.swarm, "totalLaunched", launched)?;
    set_number(&mut state.swarm, "totalExpired", expired)?;
    set_number(&mut state.swarm, "decayProgress", rounded(progress, 6))?;
    set_number(&mut state.swarm, "generationKw", generation)
}

fn sync_swarm(base: &Map<String, Value>, state: &mut DysonState) -> anyhow::Result<()> {
    ensure_orbit(state, "helios")?;
    for field in ["sailsInOrbit", "totalLaunched", "totalExpired"] {
        adjust_orbit_aggregate(state, field)?;
    }
    for system_id in SYSTEM_IDS {
        let per_sail = sail_power(base, system_id);
        for orbit in orbits_for_mut(state, system_id)?
            .iter_mut()
            .filter_map(Value::as_object_mut)
        {
            let sails = finite(orbit.get("sailsInOrbit")).floor().max(0.0);
            let launched = finite(orbit.get("totalLaunched")).floor().max(sails);
            let expired = finite(orbit.get("totalExpired")).floor().max(0.0);
            let progress = finite(orbit.get("decayProgress")).max(0.0) % 1.0;
            set_number(orbit, "sailsInOrbit", sails)?;
            set_number(orbit, "totalLaunched", launched)?;
            set_number(orbit, "totalExpired", expired)?;
            set_number(orbit, "decayProgress", progress)?;
            set_number(orbit, "generationKw", sails * per_sail)?;
        }
    }
    aggregate_swarm(state)
}

fn frame_complete(frame: &Map<String, Value>) -> bool {
    finite(frame.get("completedStructurePoints")) >= finite(frame.get("requiredStructurePoints"))
}

fn shell_active(layer: &Map<String, Value>, shell: &Map<String, Value>) -> bool {
    let Some(boundaries) = shell.get("boundaryFrameIds").and_then(Value::as_array) else {
        return false;
    };
    if boundaries.is_empty() {
        return false;
    }
    let frames = layer
        .get("frames")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    boundaries.iter().all(|frame_id| {
        frame_id.as_str().is_some_and(|frame_id| {
            frames
                .iter()
                .filter_map(Value::as_object)
                .any(|frame| text(frame, "id") == Some(frame_id) && frame_complete(frame))
        })
    })
}

fn reconcile_plan(plan: &mut Map<String, Value>) -> anyhow::Result<()> {
    let structure_points = finite(plan.get("structurePoints")).floor().max(0.0);
    set_number(plan, "structurePoints", structure_points)?;
    let mut structure_cursor: f64 = 0.0;
    let layers = plan
        .get_mut("layers")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| anyhow!("native Dyson plan layers are missing"))?;
    for layer in layers.iter_mut().filter_map(Value::as_object_mut) {
        let floor = finite(layer.get("structureAllocationFloor"))
            .floor()
            .max(0.0);
        set_number(layer, "structureAllocationFloor", floor)?;
        structure_cursor = structure_cursor.max(floor);
        let mut budget = (structure_points - structure_cursor).max(0.0);
        let mut requirement = 0.0;
        for key in ["nodes", "frames"] {
            let entries = layer
                .get_mut(key)
                .and_then(Value::as_array_mut)
                .ok_or_else(|| anyhow!("native Dyson plan {key} are missing"))?;
            for entry in entries.iter_mut().filter_map(Value::as_object_mut) {
                let required = finite(entry.get("requiredStructurePoints"))
                    .floor()
                    .max(1.0);
                let completed = required.min(budget);
                budget -= completed;
                requirement += required;
                set_number(entry, "requiredStructurePoints", required)?;
                set_number(entry, "completedStructurePoints", completed)?;
            }
        }
        structure_cursor += requirement;
    }
    let shell_sails = finite(plan.get("shellSails")).floor().max(0.0);
    set_number(plan, "shellSails", shell_sails)?;
    let mut sail_cursor: f64 = 0.0;
    let layers = plan
        .get_mut("layers")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| anyhow!("native Dyson plan layers are missing"))?;
    for layer_value in layers {
        let layer_snapshot = layer_value
            .as_object()
            .cloned()
            .ok_or_else(|| anyhow!("native Dyson layer is invalid"))?;
        let layer = layer_value
            .as_object_mut()
            .ok_or_else(|| anyhow!("native Dyson layer is invalid"))?;
        let floor = finite(layer.get("shellAllocationFloor")).floor().max(0.0);
        set_number(layer, "shellAllocationFloor", floor)?;
        sail_cursor = sail_cursor.max(floor);
        let shells = layer
            .get_mut("shells")
            .and_then(Value::as_array_mut)
            .ok_or_else(|| anyhow!("native Dyson plan shells are missing"))?;
        for shell in shells.iter_mut().filter_map(Value::as_object_mut) {
            let capacity = finite(shell.get("sailCapacity")).floor().max(1.0);
            set_number(shell, "sailCapacity", capacity)?;
            if !shell_active(&layer_snapshot, shell) {
                set_number(shell, "absorbedSails", 0.0)?;
                continue;
            }
            let budget = (shell_sails - sail_cursor).max(0.0);
            set_number(shell, "absorbedSails", capacity.min(budget))?;
            sail_cursor += capacity;
        }
    }
    Ok(())
}

fn sync_sphere(state: &mut DysonState) -> anyhow::Result<()> {
    let planned_structure = state
        .plans
        .values()
        .filter_map(Value::as_object)
        .map(|plan| finite(plan.get("structurePoints")).floor().max(0.0))
        .sum::<f64>();
    let planned_sails = state
        .plans
        .values()
        .filter_map(Value::as_object)
        .map(|plan| finite(plan.get("shellSails")).floor().max(0.0))
        .sum::<f64>();
    let legacy_structure = finite(state.sphere.get("structurePoints"));
    let legacy_sails = finite(state.sphere.get("shellSails"));
    let helios = state
        .plans
        .get_mut("helios")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native Dyson Helios plan is missing"))?;
    if legacy_structure > planned_structure {
        let current = finite(helios.get("structurePoints"));
        set_number(
            helios,
            "structurePoints",
            current + (legacy_structure - planned_structure).floor(),
        )?;
    }
    if legacy_sails > planned_sails {
        let current = finite(helios.get("shellSails"));
        set_number(
            helios,
            "shellSails",
            current + (legacy_sails - planned_sails).floor(),
        )?;
    }
    for plan in state.plans.values_mut().filter_map(Value::as_object_mut) {
        reconcile_plan(plan)?;
    }
    Ok(())
}

fn plan_shell_capacity(plan: &Map<String, Value>) -> f64 {
    let layers = plan
        .get("layers")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let mut found_shell = false;
    let mut capacity = 0.0;
    for layer in layers.iter().filter_map(Value::as_object) {
        for shell in layer
            .get("shells")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_object)
        {
            found_shell = true;
            if shell_active(layer, shell) {
                capacity += finite(shell.get("sailCapacity"));
            }
        }
    }
    if !found_shell && layers.is_empty() {
        finite(plan.get("structurePoints")) * DYSON_SHELL_CAPACITY_PER_STRUCTURE
    } else {
        capacity
    }
}

fn update_generation(base: &Map<String, Value>, state: &mut DysonState) -> anyhow::Result<()> {
    sync_swarm(base, state)?;
    sync_sphere(state)?;
    let structure = state
        .plans
        .values()
        .filter_map(Value::as_object)
        .map(|plan| finite(plan.get("structurePoints")))
        .sum::<f64>();
    let shell_sails = state
        .plans
        .values()
        .filter_map(Value::as_object)
        .map(|plan| finite(plan.get("shellSails")))
        .sum::<f64>();
    let multiplier = power_multiplier(base);
    let generation = SYSTEM_IDS
        .iter()
        .filter_map(|system_id| {
            state
                .plans
                .get(*system_id)
                .and_then(Value::as_object)
                .map(|plan| {
                    (finite(plan.get("structurePoints")).floor() * DYSON_STRUCTURE_POWER_KW
                        + finite(plan.get("shellSails")).floor() * DYSON_SHELL_SAIL_POWER_KW)
                        * multiplier
                        * luminosity(base, system_id)
                })
        })
        .sum::<f64>()
        .floor();
    set_number(&mut state.sphere, "structurePoints", structure)?;
    set_number(&mut state.sphere, "shellSails", shell_sails)?;
    set_number(&mut state.sphere, "generationKw", generation)
}

fn consume_orbit_sails(
    base: &Map<String, Value>,
    state: &mut DysonState,
    system_id: &str,
    amount: f64,
) -> anyhow::Result<f64> {
    let mut remaining = amount.floor().max(0.0);
    let per_sail = sail_power(base, system_id);
    for orbit in orbits_for_mut(state, system_id)?
        .iter_mut()
        .filter_map(Value::as_object_mut)
    {
        if remaining < 1.0 {
            break;
        }
        let sails = finite(orbit.get("sailsInOrbit")).floor().max(0.0);
        let removed = sails.min(remaining);
        set_number(orbit, "sailsInOrbit", sails - removed)?;
        set_number(orbit, "generationKw", (sails - removed) * per_sail)?;
        remaining -= removed;
    }
    aggregate_swarm(state)?;
    Ok(amount - remaining)
}

fn absorb(base: &Map<String, Value>, state: &mut DysonState, seconds: f64) -> anyhow::Result<()> {
    update_generation(base, state)?;
    if !completed(base, "dyson_shell") || seconds <= EPSILON {
        return Ok(());
    }
    sync_swarm(base, state)?;
    let multiplier = absorption_multiplier(base);
    let mut total_absorbed = 0.0;
    let mut aggregate_progress = 0.0;
    for system_id in SYSTEM_IDS {
        let plan_snapshot = state
            .plans
            .get(system_id)
            .and_then(Value::as_object)
            .cloned()
            .ok_or_else(|| anyhow!("native Dyson plan is missing: {system_id}"))?;
        let structure = finite(plan_snapshot.get("structurePoints"))
            .floor()
            .max(0.0);
        let free = (plan_shell_capacity(&plan_snapshot)
            - finite(plan_snapshot.get("shellSails")).floor().max(0.0))
        .max(0.0);
        let in_orbit = orbits_for(state, system_id)
            .iter()
            .filter_map(Value::as_object)
            .map(|orbit| finite(orbit.get("sailsInOrbit")).floor().max(0.0))
            .sum::<f64>();
        let mut progress = state
            .engineering
            .get("absorptionProgressBySystem")
            .and_then(Value::as_object)
            .and_then(|progress| progress.get(system_id))
            .map(|value| finite(Some(value)).max(0.0))
            .unwrap_or(0.0);
        if structure < 1.0 || free < 1.0 || in_orbit < 1.0 {
            if free < 1.0 {
                progress = 0.0;
            }
            state
                .engineering
                .get_mut("absorptionProgressBySystem")
                .and_then(Value::as_object_mut)
                .ok_or_else(|| anyhow!("native Dyson absorption progress is missing"))?
                .insert(
                    system_id.to_owned(),
                    Value::from(rounded(progress % 1.0, 6)),
                );
            aggregate_progress += progress;
            continue;
        }
        let accumulated = progress
            + structure * DYSON_SAIL_ABSORPTION_PER_STRUCTURE_PER_SECOND * multiplier * seconds;
        let requested = free.min(in_orbit).min((accumulated + EPSILON).floor());
        let consumed = consume_orbit_sails(base, state, system_id, requested)?;
        if consumed > 0.0 {
            let plan = state
                .plans
                .get_mut(system_id)
                .and_then(Value::as_object_mut)
                .ok_or_else(|| anyhow!("native Dyson plan disappeared"))?;
            let current = finite(plan.get("shellSails"));
            set_number(plan, "shellSails", (current + consumed).floor())?;
            reconcile_plan(plan)?;
            total_absorbed += consumed;
        }
        progress = (accumulated - consumed).max(0.0);
        state
            .engineering
            .get_mut("absorptionProgressBySystem")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native Dyson absorption progress is missing"))?
            .insert(
                system_id.to_owned(),
                Value::from(rounded(progress.min(0.999_999), 6)),
            );
        aggregate_progress += progress;
    }
    let absorbed = finite(state.sphere.get("totalSailsAbsorbed"));
    set_number(
        &mut state.sphere,
        "totalSailsAbsorbed",
        (absorbed + total_absorbed).floor(),
    )?;
    set_number(
        &mut state.sphere,
        "absorptionProgress",
        rounded((aggregate_progress % 1.0).min(0.999_999), 6),
    )?;
    update_generation(base, state)
}

fn decay(base: &Map<String, Value>, state: &mut DysonState, seconds: f64) -> anyhow::Result<()> {
    sync_swarm(base, state)?;
    if seconds <= EPSILON {
        return Ok(());
    }
    let lifetime = sail_lifetime(base);
    for system_id in SYSTEM_IDS {
        let per_sail = sail_power(base, system_id);
        for orbit in orbits_for_mut(state, system_id)?
            .iter_mut()
            .filter_map(Value::as_object_mut)
        {
            let sails = finite(orbit.get("sailsInOrbit")).floor().max(0.0);
            if sails < 1.0 {
                set_number(orbit, "generationKw", 0.0)?;
                continue;
            }
            let accumulated =
                finite(orbit.get("decayProgress")).max(0.0) + sails * seconds / lifetime;
            let expired = sails.min((accumulated + EPSILON).floor());
            let remaining = sails - expired;
            let total_expired = finite(orbit.get("totalExpired"));
            set_number(orbit, "sailsInOrbit", remaining)?;
            set_number(orbit, "totalExpired", (total_expired + expired).floor())?;
            set_number(
                orbit,
                "decayProgress",
                rounded((accumulated - expired).max(0.0), 6),
            )?;
            set_number(orbit, "generationKw", remaining * per_sail)?;
        }
    }
    aggregate_swarm(state)
}

pub(crate) fn advance_environment(
    base: &mut Map<String, Value>,
    seconds: f64,
) -> anyhow::Result<()> {
    let snapshot = base.clone();
    let mut state = load(base)?;
    absorb(&snapshot, &mut state, seconds)?;
    decay(&snapshot, &mut state, seconds)?;
    save(base, state);
    Ok(())
}

fn receiver_capacity(base: &Map<String, Value>) -> f64 {
    RAY_RECEIVER_CAPACITY_KW
        * (1.0
            + if completed(base, "ray_transmission_1") {
                0.5
            } else {
                0.0
            }
            + if completed(base, "ray_transmission_2") {
                0.5
            } else {
                0.0
            })
        * power_multiplier(base)
}

fn system_generation(base: &Map<String, Value>, state: &DysonState, system_id: &str) -> f64 {
    let swarm = orbits_for(state, system_id)
        .iter()
        .filter_map(Value::as_object)
        .map(|orbit| finite(orbit.get("generationKw")).max(0.0))
        .sum::<f64>();
    let sphere = state
        .plans
        .get(system_id)
        .and_then(Value::as_object)
        .map(|plan| {
            (finite(plan.get("structurePoints")).floor().max(0.0) * DYSON_STRUCTURE_POWER_KW
                + finite(plan.get("shellSails")).floor().max(0.0) * DYSON_SHELL_SAIL_POWER_KW)
                * power_multiplier(base)
                * luminosity(base, system_id)
        })
        .unwrap_or(0.0);
    swarm + sphere
}

fn output_capacity(
    state: &CoreState,
    base: &Map<String, Value>,
    entity: &Map<String, Value>,
) -> f64 {
    let limit = base
        .get("settings")
        .and_then(Value::as_object)
        .and_then(|settings| settings.get("productionBufferLimit"))
        .map(|value| finite(Some(value)).floor().clamp(1_000.0, 100_000_000.0))
        .unwrap_or(1_000_000.0);
    text(entity, "buildingId")
        .and_then(|id| state.catalog.buildings.get(id))
        .map(|building| {
            let count = finite(entity.get("machineCount")).floor().max(1.0);
            if building.output_capacity <= 0.0 {
                0.0
            } else {
                (building.output_capacity.floor() * count).min(limit)
            }
        })
        .unwrap_or(0.0)
}

fn ray_receiver_runnable(
    state: &CoreState,
    base: &Map<String, Value>,
    entity: &Map<String, Value>,
) -> bool {
    let Some(recipe_id) = text(entity, "recipeId") else {
        return false;
    };
    let Some(recipe) = state.catalog.recipes.get(recipe_id) else {
        return false;
    };
    if recipe
        .required_tech_id
        .as_deref()
        .is_some_and(|id| !completed(base, id))
    {
        return false;
    }
    if recipe_id == "ray_power" {
        return true;
    }
    if recipe_id != "critical_photon" {
        return false;
    }
    let current = entity
        .get("outputs")
        .and_then(Value::as_object)
        .and_then(|outputs| outputs.get("critical_photon"))
        .map(|value| finite(Some(value)))
        .unwrap_or(0.0);
    output_capacity(state, base, entity) - current + EPSILON >= 1.0
}

pub(crate) fn calculate_reception(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entities: &[Value],
) -> anyhow::Result<Reception> {
    let dyson = load(base)?;
    let rated = receiver_capacity(base);
    let receivers = entities
        .iter()
        .filter_map(Value::as_object)
        .filter(|entity| {
            text(entity, "kind") == Some("machine")
                && text(entity, "buildingId") == Some("ray_receiver")
                && finite(entity.get("machineCount")) > 0.0
                && matches!(
                    text(entity, "recipeId"),
                    Some("ray_power" | "critical_photon")
                )
                && ray_receiver_runnable(state, base, entity)
        })
        .collect::<Vec<_>>();
    let mut generation_by_system = HashMap::<String, f64>::new();
    let mut capacity_by_system = HashMap::<String, f64>::new();
    for receiver in &receivers {
        let system_id = system_for_planet(state, text(receiver, "planetId").unwrap_or_default())
            .ok_or_else(|| anyhow!("native Dyson receiver planet is unknown"))?;
        generation_by_system
            .entry(system_id.to_owned())
            .or_insert_with(|| system_generation(base, &dyson, system_id));
        *capacity_by_system.entry(system_id.to_owned()).or_default() +=
            rated * finite(receiver.get("machineCount"));
    }
    let mut result = Reception::default();
    let mut receiver_load = 0.0;
    for receiver in receivers {
        let entity_id = text(receiver, "id").unwrap_or_default();
        let system_id = system_for_planet(state, text(receiver, "planetId").unwrap_or_default())
            .ok_or_else(|| anyhow!("native Dyson receiver planet is unknown"))?;
        let capacity = capacity_by_system.get(system_id).copied().unwrap_or(0.0);
        let efficiency = if capacity <= EPSILON {
            0.0
        } else {
            (generation_by_system.get(system_id).copied().unwrap_or(0.0) / capacity).min(1.0)
        };
        let allocation = rated * finite(receiver.get("machineCount")) * efficiency;
        result
            .allocation_by_entity
            .insert(entity_id.to_owned(), allocation);
        result
            .efficiency_by_entity
            .insert(entity_id.to_owned(), efficiency);
        if text(receiver, "recipeId") == Some("ray_power") {
            result
                .ray_power_by_entity
                .insert(entity_id.to_owned(), allocation);
        }
        receiver_load += allocation;
    }
    base.get_mut("dysonSwarm")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native Dyson swarm is missing"))?
        .insert("receiverLoadKw".to_owned(), Value::from(receiver_load));
    Ok(result)
}

pub(crate) fn valid_ejector_target(
    state: &CoreState,
    base: &Map<String, Value>,
    entity: &Map<String, Value>,
) -> bool {
    let Some(system_id) = system_for_planet(state, text(entity, "planetId").unwrap_or_default())
    else {
        return false;
    };
    let Some(target_id) = text(entity, "targetDysonOrbitId") else {
        return false;
    };
    base.get("dysonEngineering")
        .and_then(Value::as_object)
        .and_then(|engineering| engineering.get("orbitsBySystem"))
        .and_then(Value::as_object)
        .and_then(|systems| systems.get(system_id))
        .and_then(Value::as_array)
        .is_some_and(|orbits| {
            orbits
                .iter()
                .filter_map(Value::as_object)
                .any(|orbit| text(orbit, "id") == Some(target_id))
        })
}

pub(crate) fn launch_factor(base: &Map<String, Value>, recipe_id: &str) -> f64 {
    if !matches!(recipe_id, "solar_sail_launch" | "carrier_rocket_launch") {
        return 1.0;
    }
    let Some(engineering) = base.get("dysonEngineering").and_then(Value::as_object) else {
        return 0.0;
    };
    if engineering.get("launchEnabled").and_then(Value::as_bool) != Some(true) {
        return 0.0;
    }
    let mode = text(engineering, "launchMode").unwrap_or("balanced");
    if mode == "swarm" && recipe_id == "carrier_rocket_launch"
        || mode == "sphere" && recipe_id == "solar_sail_launch"
    {
        return 0.0;
    }
    finite(engineering.get("launchThrottle")).clamp(0.0, 1.0)
}

pub(crate) fn launch(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entity: &Map<String, Value>,
    recipe_id: &str,
    cycles: f64,
) -> anyhow::Result<()> {
    if cycles <= 0.0 || !matches!(recipe_id, "solar_sail_launch" | "carrier_rocket_launch") {
        return Ok(());
    }
    let system_id = system_for_planet(state, text(entity, "planetId").unwrap_or_default())
        .ok_or_else(|| anyhow!("native Dyson launcher planet is unknown"))?;
    let snapshot = base.clone();
    let mut dyson = load(base)?;
    if recipe_id == "solar_sail_launch" {
        sync_swarm(&snapshot, &mut dyson)?;
        let target_id = text(entity, "targetDysonOrbitId")
            .ok_or_else(|| anyhow!("native Dyson ejector target is missing"))?;
        let per_sail = sail_power(&snapshot, system_id);
        let orbit = orbits_for_mut(&mut dyson, system_id)?
            .iter_mut()
            .filter_map(Value::as_object_mut)
            .find(|orbit| text(orbit, "id") == Some(target_id))
            .ok_or_else(|| anyhow!("native Dyson ejector target disappeared"))?;
        let sails = finite(orbit.get("sailsInOrbit"));
        let launched = finite(orbit.get("totalLaunched"));
        set_number(orbit, "sailsInOrbit", (sails + cycles).floor())?;
        set_number(orbit, "totalLaunched", (launched + cycles).floor())?;
        set_number(orbit, "generationKw", (sails + cycles).floor() * per_sail)?;
        aggregate_swarm(&mut dyson)?;
    } else {
        sync_sphere(&mut dyson)?;
        let plan = dyson
            .plans
            .get_mut(system_id)
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native Dyson launcher plan is missing"))?;
        let structure = finite(plan.get("structurePoints"));
        set_number(plan, "structurePoints", structure + cycles.floor())?;
        let total = finite(dyson.sphere.get("totalRocketsLaunched"));
        set_number(
            &mut dyson.sphere,
            "totalRocketsLaunched",
            (total + cycles).floor(),
        )?;
        reconcile_plan(plan)?;
        update_generation(&snapshot, &mut dyson)?;
    }
    let spent = finite(dyson.engineering.get("launchEnergySpentMj"));
    let per_cycle = if recipe_id == "solar_sail_launch" {
        DYSON_SAIL_LAUNCH_ENERGY_MJ
    } else {
        DYSON_ROCKET_LAUNCH_ENERGY_MJ
    };
    set_number(
        &mut dyson.engineering,
        "launchEnergySpentMj",
        rounded(spent + per_cycle * cycles, 3),
    )?;
    save(base, dyson);
    Ok(())
}

pub(crate) fn finalize(base: &mut Map<String, Value>) -> anyhow::Result<()> {
    let snapshot = base.clone();
    let mut state = load(base)?;
    update_generation(&snapshot, &mut state)?;
    save(base, state);
    Ok(())
}

pub(crate) fn run_ray_receivers(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entities: &mut [Value],
    seconds: f64,
    credits: &HashMap<String, f64>,
    reception: &Reception,
) -> anyhow::Result<()> {
    let mut produced = 0.0;
    for entity in entities.iter_mut().filter_map(Value::as_object_mut) {
        if text(entity, "kind") != Some("machine")
            || text(entity, "buildingId") != Some("ray_receiver")
        {
            continue;
        }
        let entity_id = text(entity, "id").unwrap_or_default().to_owned();
        let recipe_id = text(entity, "recipeId").unwrap_or_default().to_owned();
        let allocation = reception
            .allocation_by_entity
            .get(&entity_id)
            .copied()
            .unwrap_or(0.0);
        set_number(entity, "powerOutputKw", rounded(allocation, 2))?;
        set_number(entity, "productionRate", 0.0)?;
        set_number(entity, "utilization", 0.0)?;
        let Some(recipe) = state.catalog.recipes.get(&recipe_id) else {
            set_number(entity, "progress", 0.0)?;
            continue;
        };
        if recipe
            .required_tech_id
            .as_deref()
            .is_some_and(|id| !completed(base, id))
        {
            set_number(entity, "progress", 0.0)?;
            continue;
        }
        let efficiency = reception
            .efficiency_by_entity
            .get(&entity_id)
            .copied()
            .unwrap_or(0.0);
        if recipe_id == "ray_power" {
            set_number(entity, "progress", 0.0)?;
            set_number(entity, "utilization", efficiency)?;
            continue;
        }
        if recipe_id != "critical_photon" || allocation <= EPSILON {
            continue;
        }
        let building = state
            .catalog
            .buildings
            .get("ray_receiver")
            .ok_or_else(|| anyhow!("native ray receiver catalog is missing"))?;
        let cycles_per_second =
            building.speed * finite(entity.get("machineCount")) / recipe.duration;
        let potential = cycles_per_second * seconds * efficiency;
        let current = entity
            .get("outputs")
            .and_then(Value::as_object)
            .and_then(|outputs| outputs.get("critical_photon"))
            .map(|value| finite(Some(value)))
            .unwrap_or(0.0);
        let maximum = ((output_capacity(state, base, entity) - current).max(0.0)
            + crate::belts::output_credit(credits, &entity_id, "critical_photon")
            + EPSILON)
            .floor();
        if maximum < 1.0 || potential <= EPSILON {
            continue;
        }
        let progress = finite(entity.get("progress"));
        let work = potential.min((maximum - progress).max(0.0));
        let progressed = rounded(progress + work, 6);
        let cycles = maximum.min((progressed + EPSILON).floor());
        if cycles > 0.0 {
            entity
                .get_mut("outputs")
                .and_then(Value::as_object_mut)
                .ok_or_else(|| anyhow!("native ray receiver outputs are missing"))?
                .insert(
                    "critical_photon".to_owned(),
                    Value::from((current + cycles).floor()),
                );
            produced += cycles;
        }
        set_number(
            entity,
            "progress",
            rounded((progressed - cycles).max(0.0), 6),
        )?;
        let activity = if potential > EPSILON {
            (work / potential).min(1.0)
        } else {
            0.0
        };
        set_number(entity, "utilization", rounded(efficiency * activity, 4))?;
        set_number(
            entity,
            "productionRate",
            rounded(
                cycles_per_second * 60.0 * rounded(efficiency * activity, 4),
                2,
            ),
        )?;
    }
    if produced > 0.0 {
        let total = base
            .get_mut("totalProduced")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native total production record is missing"))?;
        let current = finite(total.get("critical_photon"));
        total.insert(
            "critical_photon".to_owned(),
            Value::from((current + produced).floor()),
        );
    }
    Ok(())
}

pub(crate) fn admission_reason(state: &CoreState) -> anyhow::Result<Option<&'static str>> {
    let base = state.base_value();
    for system_id in SYSTEM_IDS {
        if !base
            .get("dysonPlans")
            .and_then(Value::as_object)
            .is_some_and(|plans| plans.contains_key(system_id))
            || !base
                .get("dysonEngineering")
                .and_then(Value::as_object)
                .and_then(|engineering| engineering.get("orbitsBySystem"))
                .and_then(Value::as_object)
                .is_some_and(|systems| systems.get(system_id).is_some_and(Value::is_array))
        {
            return Ok(Some("dyson-state-shape-unsupported"));
        }
    }
    for entity in (0..state.entity_index.len())
        .map(|index| state.parse_entity(index))
        .collect::<anyhow::Result<Vec<_>>>()?
    {
        let Some(entity) = entity.as_object() else {
            bail!("native Dyson entity is invalid");
        };
        if text(entity, "buildingId") == Some("em_rail_ejector")
            && !valid_ejector_target(state, base, entity)
        {
            return Ok(Some("dyson-ejector-target-unsupported"));
        }
    }
    Ok(None)
}
