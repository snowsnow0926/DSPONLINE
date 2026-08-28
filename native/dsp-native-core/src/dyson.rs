use std::collections::{BTreeMap, HashMap, HashSet};

use anyhow::{anyhow, bail};
use serde_json::{Map, Number, Value, json};

use crate::deterministic_runtime::{DeterministicRuntime, runtime as deterministic_runtime};
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
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
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
    pub receiver_load_kw: f64,
    receiver_indices: Vec<usize>,
}

#[derive(Debug)]
struct RayReceiverReceptionProbe {
    entity_index: usize,
    planet_index: usize,
    machine_count: f64,
    ray_power: bool,
}

#[derive(Debug)]
enum RayReceiverSettlementDelta {
    Noop,
    Update {
        power_output_kw: f64,
        progress: Option<f64>,
        utilization: f64,
        production_rate: f64,
        critical_photon_output: Option<f64>,
        produced: f64,
    },
}

#[derive(Debug)]
struct RayReceiverSettlementOutcome {
    entity_index: usize,
    delta: RayReceiverSettlementDelta,
}

struct RayReceiverSettlementEnvironment<'a> {
    state: &'a CoreState,
    base: &'a Map<String, Value>,
    entities: &'a [Value],
    seconds: f64,
    credits: &'a crate::belts::OutputCredits,
    reception: &'a Reception,
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
    let value = Number::from_f64(value)
        .map(Value::Number)
        .ok_or_else(|| anyhow!("native Dyson simulation produced a non-finite number"))?;
    if let Some(target) = object.get_mut(key) {
        *target = value;
    } else {
        object.insert(key.to_owned(), value);
    }
    Ok(())
}

fn strict_non_negative_number(
    object: &Map<String, Value>,
    key: &str,
    label: &str,
    require_integer: bool,
) -> anyhow::Result<f64> {
    let value = object.get(key).and_then(Value::as_f64).unwrap_or(0.0);
    if !value.is_finite()
        || !(0.0..=MAX_SAFE_INTEGER).contains(&value)
        || require_integer && value.fract().abs() > f64::EPSILON
    {
        bail!(
            "{label} is not a non-negative safe {}",
            if require_integer { "integer" } else { "number" }
        );
    }
    Ok(value)
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

fn derived_sphere_generation(base: &Map<String, Value>, state: &DysonState) -> f64 {
    let multiplier = power_multiplier(base);
    SYSTEM_IDS
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
        .floor()
}

fn update_sphere_generation(
    base: &Map<String, Value>,
    state: &mut DysonState,
) -> anyhow::Result<()> {
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
    let generation = derived_sphere_generation(base, state);
    set_number(&mut state.sphere, "structurePoints", structure)?;
    set_number(&mut state.sphere, "shellSails", shell_sails)?;
    set_number(&mut state.sphere, "generationKw", generation)
}

fn update_generation(base: &Map<String, Value>, state: &mut DysonState) -> anyhow::Result<()> {
    sync_swarm(base, state)?;
    update_sphere_generation(base, state)
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

fn collect_ordered_receiver_probes_with_runtime<R, F>(
    runtime: &DeterministicRuntime,
    entity_indices: &[usize],
    probe: F,
) -> anyhow::Result<Vec<R>>
where
    R: Send,
    F: Fn(usize) -> anyhow::Result<R> + Send + Sync,
{
    runtime
        .indexed_map(entity_indices, |_, entity_index| probe(*entity_index))
        .into_iter()
        .collect()
}

fn probe_receiver_reception(
    state: &CoreState,
    base: &Map<String, Value>,
    entities: &[Value],
    entity_index: usize,
) -> anyhow::Result<Option<RayReceiverReceptionProbe>> {
    let Some(entity) = entities.get(entity_index).and_then(Value::as_object) else {
        return Ok(None);
    };
    if text(entity, "kind") != Some("machine")
        || text(entity, "buildingId") != Some("ray_receiver")
        || finite(entity.get("machineCount")) <= 0.0
        || !matches!(
            text(entity, "recipeId"),
            Some("ray_power" | "critical_photon")
        )
        || !ray_receiver_runnable(state, base, entity)
    {
        return Ok(None);
    }
    let planet_index = state.factory_topology.entity_planet_indices[entity_index];
    if planet_index == usize::MAX || state.catalog.planets.get(planet_index).is_none() {
        bail!("native Dyson receiver planet is unknown");
    }
    Ok(Some(RayReceiverReceptionProbe {
        entity_index,
        planet_index,
        machine_count: finite(entity.get("machineCount")),
        ray_power: text(entity, "recipeId") == Some("ray_power"),
    }))
}

fn calculate_reception_with_runtime(
    runtime: &DeterministicRuntime,
    state: &CoreState,
    base: &mut Map<String, Value>,
    entities: &[Value],
) -> anyhow::Result<Reception> {
    let dyson = load(base)?;
    let rated = receiver_capacity(base);
    // The immutable topology owns the persisted-order receiver rows. Probe
    // only those R rows while retaining all exact runtime eligibility checks;
    // record commands rebuild the topology before another admitted advance.
    let receiver_indices = &state.factory_topology.ray_receiver_indices;
    let receivers =
        collect_ordered_receiver_probes_with_runtime(runtime, receiver_indices, |entity_index| {
            probe_receiver_reception(state, base, entities, entity_index)
        })?
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    let mut generation_by_system = HashMap::<String, f64>::new();
    let mut capacity_by_system = HashMap::<String, f64>::new();
    for receiver in &receivers {
        let system_id = &state.catalog.planets[receiver.planet_index].system_id;
        generation_by_system
            .entry(system_id.clone())
            .or_insert_with(|| system_generation(base, &dyson, system_id));
        *capacity_by_system.entry(system_id.clone()).or_default() += rated * receiver.machine_count;
    }
    let mut result = Reception {
        receiver_indices: receiver_indices.clone(),
        ..Reception::default()
    };
    let mut receiver_load = 0.0;
    for receiver in receivers {
        let entity = entities[receiver.entity_index]
            .as_object()
            .expect("indexed native ray receiver disappeared");
        let entity_id = text(entity, "id").unwrap_or_default();
        let system_id = &state.catalog.planets[receiver.planet_index].system_id;
        let capacity = capacity_by_system.get(system_id).copied().unwrap_or(0.0);
        let efficiency = if capacity <= EPSILON {
            0.0
        } else {
            (generation_by_system.get(system_id).copied().unwrap_or(0.0) / capacity).min(1.0)
        };
        let allocation = rated * receiver.machine_count * efficiency;
        result
            .allocation_by_entity
            .insert(entity_id.to_owned(), allocation);
        result
            .efficiency_by_entity
            .insert(entity_id.to_owned(), efficiency);
        if receiver.ray_power {
            result
                .ray_power_by_entity
                .insert(entity_id.to_owned(), allocation);
        }
        // This accumulation order is observable at high counts. Keep replay
        // in the original entity order instead of reducing worker-local sums.
        receiver_load += allocation;
    }
    result.receiver_load_kw = receiver_load;
    base.get_mut("dysonSwarm")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native Dyson swarm is missing"))?
        .insert("receiverLoadKw".to_owned(), Value::from(receiver_load));
    Ok(result)
}

pub(crate) fn calculate_reception(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entities: &[Value],
) -> anyhow::Result<Reception> {
    calculate_reception_with_runtime(deterministic_runtime(), state, base, entities)
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

/// Returns the largest whole-second horizon for a stable per-system rocket
/// rate without crossing any public JavaScript safe-integer counter. This is
/// intentionally narrower than ordinary `launch`: it neither consumes entity
/// caches nor infers production, and is callable only after `pure_idle` has
/// proved the matching material sink.
pub(crate) fn certified_rocket_launch_capacity_seconds(
    base: &Map<String, Value>,
    launches_per_second_by_system: &BTreeMap<String, i128>,
) -> anyhow::Result<i128> {
    if launches_per_second_by_system.is_empty() {
        bail!("certified rocket rate has no target system");
    }
    let dyson = load(base)?;
    validate_certified_dyson_commit(base, &dyson)?;
    let max_safe = MAX_SAFE_INTEGER as i128;
    let global_structure = strict_non_negative_number(
        &dyson.sphere,
        "structurePoints",
        "dysonSphere.structurePoints",
        true,
    )? as i128;
    let global_shell =
        strict_non_negative_number(&dyson.sphere, "shellSails", "dysonSphere.shellSails", true)?
            as i128;
    let rockets_launched = strict_non_negative_number(
        &dyson.sphere,
        "totalRocketsLaunched",
        "dysonSphere.totalRocketsLaunched",
        true,
    )? as i128;
    let launch_energy = strict_non_negative_number(
        &dyson.engineering,
        "launchEnergySpentMj",
        "dysonEngineering.launchEnergySpentMj",
        false,
    )?;

    let mut planned_structure = 0_i128;
    let mut planned_shell = 0_i128;
    for (system_id, plan) in &dyson.plans {
        let plan = plan
            .as_object()
            .ok_or_else(|| anyhow!("dysonPlans.{system_id} is not an object"))?;
        planned_structure = planned_structure
            .checked_add(strict_non_negative_number(
                plan,
                "structurePoints",
                &format!("dysonPlans.{system_id}.structurePoints"),
                true,
            )? as i128)
            .ok_or_else(|| anyhow!("Dyson planned structure total overflowed"))?;
        planned_shell = planned_shell
            .checked_add(strict_non_negative_number(
                plan,
                "shellSails",
                &format!("dysonPlans.{system_id}.shellSails"),
                true,
            )? as i128)
            .ok_or_else(|| anyhow!("Dyson planned shell total overflowed"))?;
    }
    if planned_structure != global_structure || planned_shell != global_shell {
        bail!("global Dyson sphere counters are not derived from the current per-system plans");
    }
    let current_generation = strict_non_negative_number(
        &dyson.sphere,
        "generationKw",
        "dysonSphere.generationKw",
        true,
    )?;
    let derived_generation = derived_sphere_generation(base, &dyson);
    if !derived_generation.is_finite()
        || derived_generation > MAX_SAFE_INTEGER
        || (current_generation - derived_generation).abs() > EPSILON
    {
        bail!("Dyson generation is not the safe derived value for current plans");
    }

    let mut horizon = max_safe;
    let mut total_rate = 0_i128;
    let mut generation_rate = 0.0_f64;
    for (system_id, rate) in launches_per_second_by_system {
        if *rate <= 0 || *rate > max_safe {
            bail!("dysonPlans.{system_id} has an invalid certified rocket rate");
        }
        if !SYSTEM_IDS.contains(&system_id.as_str()) {
            bail!("dysonPlans.{system_id} is not a supported Dyson target system");
        }
        let plan = dyson
            .plans
            .get(system_id)
            .and_then(Value::as_object)
            .ok_or_else(|| anyhow!("dysonPlans.{system_id} disappeared"))?;
        let current = strict_non_negative_number(
            plan,
            "structurePoints",
            &format!("dysonPlans.{system_id}.structurePoints"),
            true,
        )? as i128;
        horizon = horizon.min(max_safe.saturating_sub(current) / rate);
        total_rate = total_rate
            .checked_add(*rate)
            .ok_or_else(|| anyhow!("certified rocket rate sum overflowed"))?;
        generation_rate += *rate as f64
            * DYSON_STRUCTURE_POWER_KW
            * power_multiplier(base)
            * luminosity(base, system_id);
    }
    if total_rate <= 0 || total_rate > max_safe {
        bail!("certified rocket rate sum is invalid");
    }
    horizon = horizon
        .min(max_safe.saturating_sub(global_structure) / total_rate)
        .min(max_safe.saturating_sub(rockets_launched) / total_rate);

    let launch_energy_rate = total_rate as f64 * DYSON_ROCKET_LAUNCH_ENERGY_MJ;
    if !launch_energy_rate.is_finite() || launch_energy_rate <= 0.0 {
        bail!("certified rocket launch-energy rate is invalid");
    }
    horizon =
        horizon.min(((MAX_SAFE_INTEGER - launch_energy) / launch_energy_rate).floor() as i128);
    if !generation_rate.is_finite() || generation_rate <= 0.0 {
        bail!("certified rocket generation rate is invalid");
    }
    horizon =
        horizon.min(((MAX_SAFE_INTEGER - derived_generation) / generation_rate).floor() as i128);
    Ok(horizon.max(0))
}

fn validate_certified_dyson_commit(
    base: &Map<String, Value>,
    state: &DysonState,
) -> anyhow::Result<()> {
    let global_structure = strict_non_negative_number(
        &state.sphere,
        "structurePoints",
        "dysonSphere.structurePoints",
        true,
    )? as i128;
    let global_shell =
        strict_non_negative_number(&state.sphere, "shellSails", "dysonSphere.shellSails", true)?
            as i128;
    strict_non_negative_number(
        &state.sphere,
        "totalRocketsLaunched",
        "dysonSphere.totalRocketsLaunched",
        true,
    )?;
    strict_non_negative_number(
        &state.engineering,
        "launchEnergySpentMj",
        "dysonEngineering.launchEnergySpentMj",
        false,
    )?;

    let mut planned_structure = 0_i128;
    let mut planned_shell = 0_i128;
    for (system_id, plan) in &state.plans {
        let plan = plan
            .as_object()
            .ok_or_else(|| anyhow!("dysonPlans.{system_id} is not an object"))?;
        planned_structure = planned_structure
            .checked_add(strict_non_negative_number(
                plan,
                "structurePoints",
                &format!("dysonPlans.{system_id}.structurePoints"),
                true,
            )? as i128)
            .ok_or_else(|| anyhow!("Dyson planned structure total overflowed"))?;
        planned_shell = planned_shell
            .checked_add(strict_non_negative_number(
                plan,
                "shellSails",
                &format!("dysonPlans.{system_id}.shellSails"),
                true,
            )? as i128)
            .ok_or_else(|| anyhow!("Dyson planned shell total overflowed"))?;
    }
    if planned_structure != global_structure || planned_shell != global_shell {
        bail!("certified Dyson commit counters are not derived from the per-system plans");
    }

    let generation = strict_non_negative_number(
        &state.sphere,
        "generationKw",
        "dysonSphere.generationKw",
        true,
    )?;
    let derived_generation = derived_sphere_generation(base, state);
    if !derived_generation.is_finite()
        || !(0.0..=MAX_SAFE_INTEGER).contains(&derived_generation)
        || (generation - derived_generation).abs() > EPSILON
    {
        bail!("certified Dyson commit generation is not the safe derived value");
    }
    Ok(())
}

/// Atomically commits an already funded whole-rocket vector. All mutable
/// Dyson data stays in a private clone until plan reconciliation and derived
/// power succeed; the caller's map is unchanged on error.
pub(crate) fn apply_certified_rocket_launches(
    base: &mut Map<String, Value>,
    launches_by_system: &BTreeMap<String, i128>,
) -> anyhow::Result<i128> {
    if launches_by_system.is_empty() {
        return Ok(0);
    }
    if certified_rocket_launch_capacity_seconds(base, launches_by_system)? < 1 {
        bail!("certified rocket launch vector exceeds a safe Dyson counter boundary");
    }
    let mut dyson = load(base)?;
    let mut total = 0_i128;
    for (system_id, amount) in launches_by_system {
        let plan = dyson
            .plans
            .get_mut(system_id)
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("dysonPlans.{system_id} disappeared before commit"))?;
        let current = strict_non_negative_number(
            plan,
            "structurePoints",
            &format!("dysonPlans.{system_id}.structurePoints"),
            true,
        )? as i128;
        let next = current
            .checked_add(*amount)
            .ok_or_else(|| anyhow!("dysonPlans.{system_id}.structurePoints overflowed"))?;
        set_number(plan, "structurePoints", next as f64)?;
        total = total
            .checked_add(*amount)
            .ok_or_else(|| anyhow!("certified rocket launch total overflowed"))?;
    }
    let launched = strict_non_negative_number(
        &dyson.sphere,
        "totalRocketsLaunched",
        "dysonSphere.totalRocketsLaunched",
        true,
    )? as i128;
    set_number(
        &mut dyson.sphere,
        "totalRocketsLaunched",
        launched
            .checked_add(total)
            .ok_or_else(|| anyhow!("dysonSphere.totalRocketsLaunched overflowed"))? as f64,
    )?;
    let spent = strict_non_negative_number(
        &dyson.engineering,
        "launchEnergySpentMj",
        "dysonEngineering.launchEnergySpentMj",
        false,
    )?;
    set_number(
        &mut dyson.engineering,
        "launchEnergySpentMj",
        rounded(spent + total as f64 * DYSON_ROCKET_LAUNCH_ENERGY_MJ, 3),
    )?;
    update_sphere_generation(base, &mut dyson)?;
    validate_certified_dyson_commit(base, &dyson)?;
    save(base, dyson);
    Ok(total)
}

/// Returns a conservative whole-second horizon for a certified, stable
/// per-orbit solar-sail launch schedule. Existing orbit stock is reserved once
/// for every monotonic lifecycle counter it can still enter; future launches
/// are then bounded by their certified rate. This deliberately underestimates
/// the horizon near a safe-integer boundary instead of relying on expiry or
/// absorption timing to make a larger window happen to fit.
pub(crate) fn certified_sail_launch_capacity_seconds(
    base: &Map<String, Value>,
    launches_per_second_by_orbit: &BTreeMap<String, BTreeMap<String, i128>>,
) -> anyhow::Result<i128> {
    if launches_per_second_by_orbit.is_empty() {
        bail!("certified solar-sail rate has no target orbit");
    }
    let dyson = load(base)?;
    validate_certified_dyson_commit(base, &dyson)?;
    let max_safe = MAX_SAFE_INTEGER as i128;
    let mut horizon = max_safe;
    let mut total_rate = 0_i128;
    let mut total_orbit_stock = 0_i128;
    let mut total_orbit_launched = 0_i128;
    let mut total_orbit_expired = 0_i128;
    let mut current_swarm_generation = 0.0;
    let mut future_generation_rate = 0.0;
    let mut potential_shell_generation_from_existing_stock = 0.0;

    let reserve_counter = |horizon: &mut i128,
                           current: i128,
                           one_time_reserve: i128,
                           rate: i128,
                           label: &str|
     -> anyhow::Result<()> {
        if current < 0 || current > max_safe || one_time_reserve < 0 || rate < 0 {
            bail!("{label} has an invalid certified counter bound");
        }
        let room = max_safe - current;
        if one_time_reserve > room {
            *horizon = 0;
        } else if rate > 0 {
            *horizon = (*horizon).min((room - one_time_reserve) / rate);
        }
        Ok(())
    };

    for (system_id, orbit_rates) in launches_per_second_by_orbit {
        if !SYSTEM_IDS.contains(&system_id.as_str()) || orbit_rates.is_empty() {
            bail!("certified solar-sail target system {system_id} is invalid");
        }
    }
    for system_id in SYSTEM_IDS {
        let orbit_rates = launches_per_second_by_orbit.get(system_id);
        let orbits = orbits_for(&dyson, system_id);
        let mut seen_orbits = HashSet::new();
        let mut system_stock = 0_i128;
        let mut system_rate = 0_i128;
        let per_sail_generation = sail_power(base, system_id);
        if !per_sail_generation.is_finite() || per_sail_generation <= 0.0 {
            bail!("certified solar-sail power for {system_id} is invalid");
        }
        for (orbit_index, orbit) in orbits.iter().enumerate() {
            let orbit = orbit.as_object().ok_or_else(|| {
                anyhow!("dysonEngineering.orbitsBySystem.{system_id}.{orbit_index} is invalid")
            })?;
            let orbit_id = text(orbit, "id")
                .filter(|orbit_id| !orbit_id.is_empty())
                .ok_or_else(|| {
                    anyhow!(
                        "dysonEngineering.orbitsBySystem.{system_id}.{orbit_index}.id is invalid"
                    )
                })?;
            if !seen_orbits.insert(orbit_id.to_owned()) {
                bail!("dysonEngineering.orbitsBySystem.{system_id} repeats orbit {orbit_id}");
            }
            let rate = orbit_rates
                .and_then(|rates| rates.get(orbit_id))
                .copied()
                .unwrap_or(0);
            if rate < 0 || rate > max_safe {
                bail!("certified solar-sail rate {system_id}.{orbit_id} is invalid");
            }
            let stock = strict_non_negative_number(
                orbit,
                "sailsInOrbit",
                &format!("dysonEngineering.orbitsBySystem.{system_id}.{orbit_id}.sailsInOrbit"),
                true,
            )? as i128;
            let launched = strict_non_negative_number(
                orbit,
                "totalLaunched",
                &format!("dysonEngineering.orbitsBySystem.{system_id}.{orbit_id}.totalLaunched"),
                true,
            )? as i128;
            let expired = strict_non_negative_number(
                orbit,
                "totalExpired",
                &format!("dysonEngineering.orbitsBySystem.{system_id}.{orbit_id}.totalExpired"),
                true,
            )? as i128;
            if launched < stock {
                bail!(
                    "certified solar-sail orbit {system_id}.{orbit_id} has less launches than stock"
                );
            }
            reserve_counter(
                &mut horizon,
                stock,
                0,
                rate,
                &format!("{system_id}.{orbit_id}.sailsInOrbit"),
            )?;
            reserve_counter(
                &mut horizon,
                launched,
                0,
                rate,
                &format!("{system_id}.{orbit_id}.totalLaunched"),
            )?;
            reserve_counter(
                &mut horizon,
                expired,
                stock,
                rate,
                &format!("{system_id}.{orbit_id}.totalExpired"),
            )?;

            let orbit_generation = stock as f64 * per_sail_generation;
            let orbit_generation_rate = rate as f64 * per_sail_generation;
            if !orbit_generation.is_finite()
                || orbit_generation > MAX_SAFE_INTEGER
                || !orbit_generation_rate.is_finite()
            {
                horizon = 0;
            } else if orbit_generation_rate > 0.0 {
                horizon = horizon.min(
                    ((MAX_SAFE_INTEGER - orbit_generation) / orbit_generation_rate).floor() as i128,
                );
            }
            system_stock = system_stock
                .checked_add(stock)
                .ok_or_else(|| anyhow!("certified solar-sail system stock overflowed"))?;
            system_rate = system_rate
                .checked_add(rate)
                .ok_or_else(|| anyhow!("certified solar-sail system rate overflowed"))?;
            total_orbit_stock = total_orbit_stock
                .checked_add(stock)
                .ok_or_else(|| anyhow!("certified solar-sail orbit stock overflowed"))?;
            total_orbit_launched = total_orbit_launched
                .checked_add(launched)
                .ok_or_else(|| anyhow!("certified solar-sail orbit launch total overflowed"))?;
            total_orbit_expired = total_orbit_expired
                .checked_add(expired)
                .ok_or_else(|| anyhow!("certified solar-sail orbit expiry total overflowed"))?;
            current_swarm_generation += orbit_generation;
            future_generation_rate += orbit_generation_rate;
            potential_shell_generation_from_existing_stock += orbit_generation;
        }
        if let Some(orbit_rates) = orbit_rates {
            for (orbit_id, rate) in orbit_rates {
                if *rate <= 0 || *rate > max_safe {
                    bail!("certified solar-sail rate {system_id}.{orbit_id} is invalid");
                }
                if !seen_orbits.contains(orbit_id) {
                    bail!("certified solar-sail target {system_id}.{orbit_id} disappeared");
                }
            }
        }

        let plan = dyson
            .plans
            .get(system_id)
            .and_then(Value::as_object)
            .ok_or_else(|| anyhow!("dysonPlans.{system_id} disappeared"))?;
        let shell = strict_non_negative_number(
            plan,
            "shellSails",
            &format!("dysonPlans.{system_id}.shellSails"),
            true,
        )? as i128;
        reserve_counter(
            &mut horizon,
            shell,
            system_stock,
            system_rate,
            &format!("dysonPlans.{system_id}.shellSails"),
        )?;
        total_rate = total_rate
            .checked_add(system_rate)
            .ok_or_else(|| anyhow!("certified solar-sail rate sum overflowed"))?;
    }
    if total_rate <= 0 || total_rate > max_safe {
        bail!("certified solar-sail rate sum is invalid");
    }
    let swarm_stock = strict_non_negative_number(
        &dyson.swarm,
        "sailsInOrbit",
        "dysonSwarm.sailsInOrbit",
        true,
    )? as i128;
    let swarm_launched = strict_non_negative_number(
        &dyson.swarm,
        "totalLaunched",
        "dysonSwarm.totalLaunched",
        true,
    )? as i128;
    let swarm_expired = strict_non_negative_number(
        &dyson.swarm,
        "totalExpired",
        "dysonSwarm.totalExpired",
        true,
    )? as i128;
    if swarm_stock != total_orbit_stock
        || swarm_launched != total_orbit_launched
        || swarm_expired != total_orbit_expired
    {
        bail!("certified solar-sail global counters do not match the orbit ledger");
    }
    reserve_counter(
        &mut horizon,
        swarm_stock,
        0,
        total_rate,
        "dysonSwarm.sailsInOrbit",
    )?;
    reserve_counter(
        &mut horizon,
        swarm_launched,
        0,
        total_rate,
        "dysonSwarm.totalLaunched",
    )?;
    reserve_counter(
        &mut horizon,
        swarm_expired,
        total_orbit_stock,
        total_rate,
        "dysonSwarm.totalExpired",
    )?;
    for (key, label) in [
        ("totalSailsAbsorbed", "dysonSphere.totalSailsAbsorbed"),
        ("shellSails", "dysonSphere.shellSails"),
    ] {
        let current = strict_non_negative_number(&dyson.sphere, key, label, true)? as i128;
        reserve_counter(&mut horizon, current, total_orbit_stock, total_rate, label)?;
    }

    if !current_swarm_generation.is_finite()
        || current_swarm_generation > MAX_SAFE_INTEGER
        || !future_generation_rate.is_finite()
    {
        horizon = 0;
    } else if future_generation_rate > 0.0 {
        horizon = horizon.min(
            ((MAX_SAFE_INTEGER - current_swarm_generation) / future_generation_rate).floor()
                as i128,
        );
    }
    let current_sphere_generation = derived_sphere_generation(base, &dyson);
    if !current_sphere_generation.is_finite()
        || current_sphere_generation > MAX_SAFE_INTEGER
        || !potential_shell_generation_from_existing_stock.is_finite()
        || potential_shell_generation_from_existing_stock
            > MAX_SAFE_INTEGER - current_sphere_generation
    {
        horizon = 0;
    } else if future_generation_rate > 0.0 {
        horizon = horizon.min(
            ((MAX_SAFE_INTEGER
                - current_sphere_generation
                - potential_shell_generation_from_existing_stock)
                / future_generation_rate)
                .floor() as i128,
        );
    }
    let launch_energy = strict_non_negative_number(
        &dyson.engineering,
        "launchEnergySpentMj",
        "dysonEngineering.launchEnergySpentMj",
        false,
    )?;
    let launch_energy_rate = total_rate as f64 * DYSON_SAIL_LAUNCH_ENERGY_MJ;
    if !launch_energy_rate.is_finite() || launch_energy_rate <= 0.0 {
        bail!("certified solar-sail launch-energy rate is invalid");
    }
    horizon =
        horizon.min(((MAX_SAFE_INTEGER - launch_energy) / launch_energy_rate).floor() as i128);
    Ok(horizon.max(0))
}

const MAX_CERTIFIED_SAIL_UNBATCHED_STEPS: u64 = 10_000;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct CertifiedSailOrbitDynamic {
    system_id: String,
    orbit_id: String,
    stock: i128,
    decay_progress_bits: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct CertifiedSailSystemDynamic {
    system_id: String,
    absorption_progress_bits: u64,
    shell_open: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct CertifiedSailLifecycleSignature {
    systems: Vec<CertifiedSailSystemDynamic>,
    orbits: Vec<CertifiedSailOrbitDynamic>,
}

#[derive(Debug, Clone)]
struct CertifiedSailLifecycleCounters {
    shell_by_system: BTreeMap<String, i128>,
    launched_by_orbit: BTreeMap<(String, String), i128>,
    expired_by_orbit: BTreeMap<(String, String), i128>,
    total_absorbed: i128,
}

#[derive(Debug, Clone)]
struct CertifiedSailCycleCheckpoint {
    step: u64,
    counters: CertifiedSailLifecycleCounters,
}

fn certified_sail_cycle_snapshot(
    state: &DysonState,
) -> anyhow::Result<(
    CertifiedSailLifecycleSignature,
    CertifiedSailLifecycleCounters,
)> {
    let progress_by_system = state
        .engineering
        .get("absorptionProgressBySystem")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native Dyson absorption progress is missing"))?;
    let mut systems = Vec::with_capacity(SYSTEM_IDS.len());
    let mut orbits_dynamic = Vec::new();
    let mut shell_by_system = BTreeMap::new();
    let mut launched_by_orbit = BTreeMap::new();
    let mut expired_by_orbit = BTreeMap::new();
    for system_id in SYSTEM_IDS {
        let plan = state
            .plans
            .get(system_id)
            .and_then(Value::as_object)
            .ok_or_else(|| anyhow!("native Dyson plan is missing: {system_id}"))?;
        let shell = strict_non_negative_number(
            plan,
            "shellSails",
            &format!("dysonPlans.{system_id}.shellSails"),
            true,
        )? as i128;
        let shell_capacity = plan_shell_capacity(plan).floor();
        if !shell_capacity.is_finite() || !(0.0..=MAX_SAFE_INTEGER).contains(&shell_capacity) {
            bail!("dysonPlans.{system_id} has an invalid shell capacity");
        }
        let absorption_progress = progress_by_system
            .get(system_id)
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        if !absorption_progress.is_finite() || !(0.0..1.0 + EPSILON).contains(&absorption_progress)
        {
            bail!("Dyson absorption progress for {system_id} is invalid");
        }
        systems.push(CertifiedSailSystemDynamic {
            system_id: system_id.to_owned(),
            absorption_progress_bits: absorption_progress.to_bits(),
            shell_open: shell_capacity - shell as f64 >= 1.0,
        });
        shell_by_system.insert(system_id.to_owned(), shell);

        let mut seen = HashSet::new();
        for (orbit_index, orbit) in orbits_for(state, system_id).iter().enumerate() {
            let orbit = orbit.as_object().ok_or_else(|| {
                anyhow!("dysonEngineering.orbitsBySystem.{system_id}.{orbit_index} is invalid")
            })?;
            let orbit_id = text(orbit, "id")
                .filter(|orbit_id| !orbit_id.is_empty())
                .ok_or_else(|| {
                    anyhow!(
                        "dysonEngineering.orbitsBySystem.{system_id}.{orbit_index}.id is invalid"
                    )
                })?;
            if !seen.insert(orbit_id.to_owned()) {
                bail!("dysonEngineering.orbitsBySystem.{system_id} repeats orbit {orbit_id}");
            }
            let stock = strict_non_negative_number(
                orbit,
                "sailsInOrbit",
                &format!("{system_id}.{orbit_id}.sailsInOrbit"),
                true,
            )? as i128;
            let launched = strict_non_negative_number(
                orbit,
                "totalLaunched",
                &format!("{system_id}.{orbit_id}.totalLaunched"),
                true,
            )? as i128;
            let expired = strict_non_negative_number(
                orbit,
                "totalExpired",
                &format!("{system_id}.{orbit_id}.totalExpired"),
                true,
            )? as i128;
            let decay_progress = orbit
                .get("decayProgress")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            if !decay_progress.is_finite() || !(0.0..1.0 + EPSILON).contains(&decay_progress) {
                bail!("Dyson decay progress for {system_id}.{orbit_id} is invalid");
            }
            let key = (system_id.to_owned(), orbit_id.to_owned());
            orbits_dynamic.push(CertifiedSailOrbitDynamic {
                system_id: key.0.clone(),
                orbit_id: key.1.clone(),
                stock,
                decay_progress_bits: decay_progress.to_bits(),
            });
            launched_by_orbit.insert(key.clone(), launched);
            expired_by_orbit.insert(key, expired);
        }
    }
    let total_absorbed = strict_non_negative_number(
        &state.sphere,
        "totalSailsAbsorbed",
        "dysonSphere.totalSailsAbsorbed",
        true,
    )? as i128;
    Ok((
        CertifiedSailLifecycleSignature {
            systems,
            orbits: orbits_dynamic,
        },
        CertifiedSailLifecycleCounters {
            shell_by_system,
            launched_by_orbit,
            expired_by_orbit,
            total_absorbed,
        },
    ))
}

fn certified_sail_counter_deltas<K: Ord + Clone>(
    before: &BTreeMap<K, i128>,
    after: &BTreeMap<K, i128>,
    label: &str,
) -> anyhow::Result<BTreeMap<K, i128>> {
    if before.keys().ne(after.keys()) {
        bail!("{label} keys changed inside a certified lifecycle cycle");
    }
    before
        .iter()
        .map(|(key, before)| {
            let after = after
                .get(key)
                .expect("certified lifecycle counter key remains present");
            let delta = after
                .checked_sub(*before)
                .ok_or_else(|| anyhow!("{label} counter regressed"))?;
            Ok((key.clone(), delta))
        })
        .collect()
}

fn repeat_certified_sail_cycle(
    base: &Map<String, Value>,
    state: &mut DysonState,
    launches_per_second_by_orbit: &BTreeMap<String, BTreeMap<String, i128>>,
    before: &CertifiedSailLifecycleCounters,
    after: &CertifiedSailLifecycleCounters,
    cycle_seconds: u64,
    requested_repetitions: u64,
) -> anyhow::Result<u64> {
    if cycle_seconds == 0 || requested_repetitions == 0 {
        return Ok(0);
    }
    let shell_deltas = certified_sail_counter_deltas(
        &before.shell_by_system,
        &after.shell_by_system,
        "Dyson shell",
    )?;
    let launch_deltas = certified_sail_counter_deltas(
        &before.launched_by_orbit,
        &after.launched_by_orbit,
        "solar-sail launch",
    )?;
    let expiry_deltas = certified_sail_counter_deltas(
        &before.expired_by_orbit,
        &after.expired_by_orbit,
        "solar-sail expiry",
    )?;
    let absorbed_delta = after
        .total_absorbed
        .checked_sub(before.total_absorbed)
        .ok_or_else(|| anyhow!("solar-sail absorption counter regressed"))?;
    let cycle_seconds = i128::from(cycle_seconds);
    let mut launch_sum = 0_i128;
    for ((system_id, orbit_id), delta) in &launch_deltas {
        let rate = launches_per_second_by_orbit
            .get(system_id)
            .and_then(|orbits| orbits.get(orbit_id))
            .copied()
            .unwrap_or(0);
        let expected = rate
            .checked_mul(cycle_seconds)
            .ok_or_else(|| anyhow!("certified solar-sail cycle launch rate overflowed"))?;
        if *delta != expected {
            bail!(
                "certified solar-sail cycle launched {delta} instead of {expected} for {system_id}.{orbit_id}"
            );
        }
        launch_sum = launch_sum
            .checked_add(*delta)
            .ok_or_else(|| anyhow!("certified solar-sail cycle launch total overflowed"))?;
    }
    let expected_launch_sum = launches_per_second_by_orbit
        .values()
        .flat_map(BTreeMap::values)
        .try_fold(0_i128, |total, rate| total.checked_add(*rate))
        .ok_or_else(|| anyhow!("certified solar-sail cycle rate sum overflowed"))?
        .checked_mul(cycle_seconds)
        .ok_or_else(|| anyhow!("certified solar-sail cycle launch total overflowed"))?;
    if launch_sum != expected_launch_sum {
        bail!("certified solar-sail cycle does not close its launch ledger");
    }
    let shell_sum = shell_deltas
        .values()
        .try_fold(0_i128, |total, delta| total.checked_add(*delta))
        .ok_or_else(|| anyhow!("certified Dyson shell cycle total overflowed"))?;
    if shell_sum != absorbed_delta {
        bail!("certified solar-sail cycle does not close its absorption ledger");
    }
    let expiry_sum = expiry_deltas
        .values()
        .try_fold(0_i128, |total, delta| total.checked_add(*delta))
        .ok_or_else(|| anyhow!("certified solar-sail cycle expiry total overflowed"))?;
    if launch_sum
        != expiry_sum
            .checked_add(absorbed_delta)
            .ok_or_else(|| anyhow!("certified solar-sail cycle terminal total overflowed"))?
    {
        bail!("certified solar-sail cycle does not close its terminal flow ledger");
    }

    let mut repetitions = i128::from(requested_repetitions);
    for (system_id, delta) in &shell_deltas {
        if *delta == 0 {
            continue;
        }
        let plan = state
            .plans
            .get(system_id)
            .and_then(Value::as_object)
            .ok_or_else(|| anyhow!("native Dyson plan disappeared: {system_id}"))?;
        let current = strict_non_negative_number(
            plan,
            "shellSails",
            &format!("dysonPlans.{system_id}.shellSails"),
            true,
        )? as i128;
        let capacity = plan_shell_capacity(plan).floor();
        if !capacity.is_finite() || !(0.0..=MAX_SAFE_INTEGER).contains(&capacity) {
            bail!("dysonPlans.{system_id} has an invalid shell capacity");
        }
        repetitions = repetitions.min((capacity as i128).saturating_sub(current) / delta);
    }
    if repetitions <= 0 {
        return Ok(0);
    }

    for (system_id, delta) in shell_deltas {
        if delta == 0 {
            continue;
        }
        let plan = state
            .plans
            .get_mut(&system_id)
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native Dyson plan disappeared: {system_id}"))?;
        let current = strict_non_negative_number(
            plan,
            "shellSails",
            &format!("dysonPlans.{system_id}.shellSails"),
            true,
        )? as i128;
        let added = delta
            .checked_mul(repetitions)
            .ok_or_else(|| anyhow!("dysonPlans.{system_id}.shellSails cycle overflowed"))?;
        let next = current
            .checked_add(added)
            .ok_or_else(|| anyhow!("dysonPlans.{system_id}.shellSails overflowed"))?;
        set_number(plan, "shellSails", next as f64)?;
        reconcile_plan(plan)?;
    }
    for system_id in SYSTEM_IDS {
        for orbit in orbits_for_mut(state, system_id)?
            .iter_mut()
            .filter_map(Value::as_object_mut)
        {
            let orbit_id = text(orbit, "id")
                .ok_or_else(|| anyhow!("native Dyson orbit ID disappeared"))?
                .to_owned();
            let key = (system_id.to_owned(), orbit_id.clone());
            for (field, deltas, label) in [
                ("totalLaunched", &launch_deltas, "solar-sail launch"),
                ("totalExpired", &expiry_deltas, "solar-sail expiry"),
            ] {
                let delta = deltas
                    .get(&key)
                    .copied()
                    .ok_or_else(|| anyhow!("{label} cycle orbit disappeared"))?;
                if delta == 0 {
                    continue;
                }
                let current = strict_non_negative_number(
                    orbit,
                    field,
                    &format!("{system_id}.{orbit_id}.{field}"),
                    true,
                )? as i128;
                let added = delta
                    .checked_mul(repetitions)
                    .ok_or_else(|| anyhow!("{label} cycle overflowed"))?;
                let next = current
                    .checked_add(added)
                    .ok_or_else(|| anyhow!("{label} counter overflowed"))?;
                set_number(orbit, field, next as f64)?;
            }
        }
    }
    if absorbed_delta > 0 {
        let added = absorbed_delta
            .checked_mul(repetitions)
            .ok_or_else(|| anyhow!("solar-sail absorption cycle overflowed"))?;
        let current = strict_non_negative_number(
            &state.sphere,
            "totalSailsAbsorbed",
            "dysonSphere.totalSailsAbsorbed",
            true,
        )? as i128;
        set_number(
            &mut state.sphere,
            "totalSailsAbsorbed",
            current
                .checked_add(added)
                .ok_or_else(|| anyhow!("solar-sail absorption counter overflowed"))?
                as f64,
        )?;
    }
    // The per-orbit counters are authoritative for this private cycle jump.
    // Synchronize their legacy aggregate before `update_generation` calls
    // `sync_swarm`, otherwise that compatibility path would interpret the
    // still-stale global total as an instruction to remove the skipped events.
    aggregate_swarm(state)?;
    update_generation(base, state)?;
    validate_certified_dyson_commit(base, state)?;
    u64::try_from(repetitions)
        .map_err(|_| anyhow!("certified solar-sail cycle repetition cannot be represented"))
}

/// Advances only the Dyson sail lifecycle for a same-window-funded launch
/// schedule. Each second follows the exact engine's observable order:
/// absorption/decay first, then ejector launches. The factory, launcher caches
/// and production totals are owned by the caller's closed material ledger.
pub(crate) fn apply_certified_sail_launch_schedule(
    base: &mut Map<String, Value>,
    launches_per_second_by_orbit: &BTreeMap<String, BTreeMap<String, i128>>,
    seconds: i128,
) -> anyhow::Result<i128> {
    if seconds < 0 {
        bail!("certified solar-sail schedule has a negative duration");
    }
    if seconds == 0 {
        return Ok(0);
    }
    if certified_sail_launch_capacity_seconds(base, launches_per_second_by_orbit)? < seconds {
        bail!("certified solar-sail schedule exceeds a safe counter boundary");
    }
    let seconds = u64::try_from(seconds)
        .map_err(|_| anyhow!("certified solar-sail duration cannot be iterated"))?;
    let snapshot = base.clone();
    let mut dyson = load(base)?;
    sync_swarm(&snapshot, &mut dyson)?;
    sync_sphere(&mut dyson)?;
    let total_rate = launches_per_second_by_orbit
        .values()
        .flat_map(BTreeMap::values)
        .try_fold(0_i128, |total, rate| {
            total
                .checked_add(*rate)
                .ok_or_else(|| anyhow!("certified solar-sail rate sum overflowed"))
        })?;
    let mut seen_cycles =
        HashMap::<CertifiedSailLifecycleSignature, CertifiedSailCycleCheckpoint>::new();
    let mut step = 0_u64;
    let mut unbatched_steps = 0_u64;
    while step < seconds {
        let (signature, counters) = certified_sail_cycle_snapshot(&dyson)?;
        if let Some(previous) = seen_cycles.get(&signature).cloned() {
            let cycle_seconds = step.saturating_sub(previous.step);
            if let Some(repetitions) = (seconds - step).checked_div(cycle_seconds) {
                let repeated = repeat_certified_sail_cycle(
                    &snapshot,
                    &mut dyson,
                    launches_per_second_by_orbit,
                    &previous.counters,
                    &counters,
                    cycle_seconds,
                    repetitions,
                )?;
                if repeated > 0 {
                    step = step
                        .checked_add(cycle_seconds.checked_mul(repeated).ok_or_else(|| {
                            anyhow!("certified solar-sail cycle duration overflowed")
                        })?)
                        .ok_or_else(|| anyhow!("certified solar-sail duration overflowed"))?;
                    unbatched_steps = 0;
                    continue;
                }
            }
        } else {
            seen_cycles.insert(signature, CertifiedSailCycleCheckpoint { step, counters });
        }
        if unbatched_steps >= MAX_CERTIFIED_SAIL_UNBATCHED_STEPS {
            bail!(
                "certified solar-sail lifecycle did not reach a safely repeatable cycle within {MAX_CERTIFIED_SAIL_UNBATCHED_STEPS} steps"
            );
        }
        absorb(&snapshot, &mut dyson, 1.0)?;
        decay(&snapshot, &mut dyson, 1.0)?;
        for (system_id, orbit_rates) in launches_per_second_by_orbit {
            let per_sail = sail_power(&snapshot, system_id);
            let orbits = orbits_for_mut(&mut dyson, system_id)?;
            for (orbit_id, rate) in orbit_rates {
                let orbit = orbits
                    .iter_mut()
                    .filter_map(Value::as_object_mut)
                    .find(|orbit| text(orbit, "id") == Some(orbit_id.as_str()))
                    .ok_or_else(|| {
                        anyhow!("certified solar-sail target {system_id}.{orbit_id} disappeared")
                    })?;
                let stock = strict_non_negative_number(
                    orbit,
                    "sailsInOrbit",
                    &format!("dysonEngineering.orbitsBySystem.{system_id}.{orbit_id}.sailsInOrbit"),
                    true,
                )? as i128;
                let launched = strict_non_negative_number(
                    orbit,
                    "totalLaunched",
                    &format!(
                        "dysonEngineering.orbitsBySystem.{system_id}.{orbit_id}.totalLaunched"
                    ),
                    true,
                )? as i128;
                let next_stock = stock
                    .checked_add(*rate)
                    .ok_or_else(|| anyhow!("certified solar-sail orbit stock overflowed"))?;
                let next_launched = launched
                    .checked_add(*rate)
                    .ok_or_else(|| anyhow!("certified solar-sail launch counter overflowed"))?;
                set_number(orbit, "sailsInOrbit", next_stock as f64)?;
                set_number(orbit, "totalLaunched", next_launched as f64)?;
                set_number(orbit, "generationKw", next_stock as f64 * per_sail)?;
            }
        }
        // Keep the legacy/global fields synchronized before the next exact
        // lifecycle second; otherwise sync_swarm would interpret the newly
        // launched orbit stock as a legacy aggregate mismatch.
        aggregate_swarm(&mut dyson)?;
        step += 1;
        unbatched_steps += 1;
    }
    let launched = total_rate
        .checked_mul(i128::from(seconds))
        .ok_or_else(|| anyhow!("certified solar-sail schedule total overflowed"))?;
    let spent = strict_non_negative_number(
        &dyson.engineering,
        "launchEnergySpentMj",
        "dysonEngineering.launchEnergySpentMj",
        false,
    )?;
    set_number(
        &mut dyson.engineering,
        "launchEnergySpentMj",
        rounded(spent + launched as f64 * DYSON_SAIL_LAUNCH_ENERGY_MJ, 3),
    )?;
    update_generation(&snapshot, &mut dyson)?;
    validate_certified_dyson_commit(&snapshot, &dyson)?;
    save(base, dyson);
    Ok(launched)
}

pub(crate) fn finalize(base: &mut Map<String, Value>) -> anyhow::Result<()> {
    let snapshot = base.clone();
    let mut state = load(base)?;
    update_generation(&snapshot, &mut state)?;
    save(base, state);
    Ok(())
}

fn validate_receiver_number(value: f64) -> anyhow::Result<f64> {
    if value.is_finite() {
        Ok(value)
    } else {
        bail!("native Dyson simulation produced a non-finite number")
    }
}

fn probe_ray_receiver_settlement(
    environment: &RayReceiverSettlementEnvironment<'_>,
    entity_index: usize,
) -> anyhow::Result<RayReceiverSettlementDelta> {
    let Some(entity) = environment
        .entities
        .get(entity_index)
        .and_then(Value::as_object)
    else {
        return Ok(RayReceiverSettlementDelta::Noop);
    };
    if text(entity, "kind") != Some("machine") || text(entity, "buildingId") != Some("ray_receiver")
    {
        return Ok(RayReceiverSettlementDelta::Noop);
    }
    let entity_id = text(entity, "id").unwrap_or_default();
    let recipe_id = text(entity, "recipeId").unwrap_or_default();
    let allocation = environment
        .reception
        .allocation_by_entity
        .get(entity_id)
        .copied()
        .unwrap_or(0.0);
    let power_output_kw = validate_receiver_number(rounded(allocation, 2))?;
    let baseline = |progress| RayReceiverSettlementDelta::Update {
        power_output_kw,
        progress,
        utilization: 0.0,
        production_rate: 0.0,
        critical_photon_output: None,
        produced: 0.0,
    };
    let Some(recipe) = environment.state.catalog.recipes.get(recipe_id) else {
        return Ok(baseline(Some(0.0)));
    };
    if recipe
        .required_tech_id
        .as_deref()
        .is_some_and(|id| !completed(environment.base, id))
    {
        return Ok(baseline(Some(0.0)));
    }
    let efficiency = environment
        .reception
        .efficiency_by_entity
        .get(entity_id)
        .copied()
        .unwrap_or(0.0);
    if recipe_id == "ray_power" {
        return Ok(RayReceiverSettlementDelta::Update {
            power_output_kw,
            progress: Some(0.0),
            utilization: validate_receiver_number(efficiency)?,
            production_rate: 0.0,
            critical_photon_output: None,
            produced: 0.0,
        });
    }
    if recipe_id != "critical_photon" || allocation <= EPSILON {
        return Ok(baseline(None));
    }
    let building = environment
        .state
        .catalog
        .buildings
        .get("ray_receiver")
        .ok_or_else(|| anyhow!("native ray receiver catalog is missing"))?;
    let cycles_per_second = building.speed * finite(entity.get("machineCount")) / recipe.duration;
    let potential = cycles_per_second * environment.seconds * efficiency;
    let current = entity
        .get("outputs")
        .and_then(Value::as_object)
        .and_then(|outputs| outputs.get("critical_photon"))
        .map(|value| finite(Some(value)))
        .unwrap_or(0.0);
    let maximum = ((output_capacity(environment.state, environment.base, entity) - current)
        .max(0.0)
        + crate::belts::output_credit(
            environment.state,
            environment.credits,
            entity_id,
            "critical_photon",
        )
        + EPSILON)
        .floor();
    if maximum < 1.0 || potential <= EPSILON {
        return Ok(baseline(None));
    }
    let progress = finite(entity.get("progress"));
    let work = potential.min((maximum - progress).max(0.0));
    let progressed = rounded(progress + work, 6);
    let cycles = maximum.min((progressed + EPSILON).floor());
    let critical_photon_output = if cycles > 0.0 {
        if entity.get("outputs").and_then(Value::as_object).is_none() {
            bail!("native ray receiver outputs are missing");
        }
        Some(validate_receiver_number((current + cycles).floor())?)
    } else {
        None
    };
    let next_progress = validate_receiver_number(rounded((progressed - cycles).max(0.0), 6))?;
    let activity = if potential > EPSILON {
        (work / potential).min(1.0)
    } else {
        0.0
    };
    let utilization = validate_receiver_number(rounded(efficiency * activity, 4))?;
    let production_rate =
        validate_receiver_number(rounded(cycles_per_second * 60.0 * utilization, 2))?;
    Ok(RayReceiverSettlementDelta::Update {
        power_output_kw,
        progress: Some(next_progress),
        utilization,
        production_rate,
        critical_photon_output,
        produced: cycles,
    })
}

fn replay_ray_receiver_settlement(
    entity: &mut Value,
    delta: RayReceiverSettlementDelta,
) -> anyhow::Result<f64> {
    let RayReceiverSettlementDelta::Update {
        power_output_kw,
        progress,
        utilization,
        production_rate,
        critical_photon_output,
        produced,
    } = delta
    else {
        return Ok(0.0);
    };
    let entity = entity
        .as_object_mut()
        .ok_or_else(|| anyhow!("native ray receiver entity disappeared before replay"))?;
    set_number(entity, "powerOutputKw", power_output_kw)?;
    set_number(entity, "productionRate", production_rate)?;
    set_number(entity, "utilization", utilization)?;
    if let Some(progress) = progress {
        set_number(entity, "progress", progress)?;
    }
    if let Some(output) = critical_photon_output {
        entity
            .get_mut("outputs")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native ray receiver outputs are missing"))?
            .insert("critical_photon".to_owned(), Value::from(output));
    }
    Ok(produced)
}

fn run_ray_receivers_with_runtime(
    runtime: &DeterministicRuntime,
    state: &CoreState,
    base: &mut Map<String, Value>,
    entities: &mut [Value],
    seconds: f64,
    credits: &crate::belts::OutputCredits,
    reception: &Reception,
) -> anyhow::Result<()> {
    let outcomes = collect_ordered_receiver_probes_with_runtime(
        runtime,
        &reception.receiver_indices,
        |entity_index| {
            probe_ray_receiver_settlement(
                &RayReceiverSettlementEnvironment {
                    state,
                    base,
                    entities,
                    seconds,
                    credits,
                    reception,
                },
                entity_index,
            )
            .map(|delta| RayReceiverSettlementOutcome {
                entity_index,
                delta,
            })
        },
    )?;
    // Validate the one shared write before replaying any entity. Probe errors
    // and a malformed total record therefore leave both inputs untouched.
    let mut produced = 0.0;
    for outcome in &outcomes {
        if let RayReceiverSettlementDelta::Update {
            produced: amount, ..
        } = &outcome.delta
            && *amount > 0.0
        {
            produced += *amount;
        }
    }
    let total_update = if produced > 0.0 {
        let total = base
            .get("totalProduced")
            .and_then(Value::as_object)
            .ok_or_else(|| anyhow!("native total production record is missing"))?;
        let current = finite(total.get("critical_photon"));
        Some(validate_receiver_number((current + produced).floor())?)
    } else {
        None
    };
    for outcome in outcomes {
        replay_ray_receiver_settlement(&mut entities[outcome.entity_index], outcome.delta)?;
    }
    if let Some(total_update) = total_update {
        base.get_mut("totalProduced")
            .and_then(Value::as_object_mut)
            .expect("validated native total production record disappeared")
            .insert("critical_photon".to_owned(), Value::from(total_update));
    }
    Ok(())
}

pub(crate) fn run_ray_receivers(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entities: &mut [Value],
    seconds: f64,
    credits: &crate::belts::OutputCredits,
    reception: &Reception,
) -> anyhow::Result<()> {
    run_ray_receivers_with_runtime(
        deterministic_runtime(),
        state,
        base,
        entities,
        seconds,
        credits,
        reception,
    )
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::{
        BeltDefinition, BuildingDefinition, CatalogSnapshot, ItemAmount, ItemDefinition,
        PlanetDefinition, RecipeDefinition, RuntimeCatalog,
    };
    use crate::deterministic_runtime::PARALLEL_MIN_ITEMS;
    use crate::state::CoreCheckpointIdentity;
    use std::collections::BTreeMap;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering as AtomicOrdering};

    fn fixture_checksum(bytes: &[u8]) -> String {
        let mut hash = 0x811c9dc5_u32;
        for byte in bytes {
            hash ^= u32::from(*byte);
            hash = hash.wrapping_mul(0x01000193);
        }
        format!("{hash:08x}")
    }

    fn fixture_catalog() -> RuntimeCatalog {
        RuntimeCatalog::validate(
            CatalogSnapshot {
                protocol_version: 1,
                registry_fingerprint: "dyson-receiver-test".to_owned(),
                planets: [("home", "helios", 0), ("ice", "borealis", 1)]
                    .into_iter()
                    .map(|(id, system_id, simulation_order)| PlanetDefinition {
                        id: id.to_owned(),
                        name: id.to_owned(),
                        system_id: system_id.to_owned(),
                        kind: "terrestrial".to_owned(),
                        orbit_index: simulation_order + 1,
                        simulation_order,
                        orbital_yields: HashMap::new(),
                    })
                    .collect(),
                items: vec![ItemDefinition {
                    id: "critical_photon".to_owned(),
                    name: "critical_photon".to_owned(),
                    kind: "solid".to_owned(),
                    fuel_energy_mj: 0.0,
                }],
                buildings: vec![BuildingDefinition {
                    id: "ray_receiver".to_owned(),
                    kind: "machine".to_owned(),
                    speed: 2.5,
                    input_capacity: 0.0,
                    output_capacity: 100.0,
                    power_demand_kw: 0.0,
                    power_generation_kw: 0.0,
                    power_charge_kw: 0.0,
                    energy_capacity_mj: 0.0,
                    fuel_item_ids: Vec::new(),
                    fuel_efficiency: 1.0,
                    family: Some("particle".to_owned()),
                    accepts: None,
                }],
                recipes: vec![
                    RecipeDefinition {
                        id: "ray_power".to_owned(),
                        name: "ray_power".to_owned(),
                        building_id: "ray_receiver".to_owned(),
                        duration: 1.0,
                        required_tech_id: None,
                        recursive_priority: 0.0,
                        recursive_manufacturing: false,
                        inputs: Vec::new(),
                        outputs: Vec::new(),
                    },
                    RecipeDefinition {
                        id: "critical_photon".to_owned(),
                        name: "critical_photon".to_owned(),
                        building_id: "ray_receiver".to_owned(),
                        duration: 1.5,
                        required_tech_id: Some("dirac_inversion".to_owned()),
                        recursive_priority: 0.0,
                        recursive_manufacturing: false,
                        inputs: Vec::new(),
                        outputs: vec![ItemAmount {
                            item_id: "critical_photon".to_owned(),
                            amount: 1.0,
                        }],
                    },
                ],
                constructions: Vec::new(),
                belts: vec![BeltDefinition {
                    tier: 1,
                    speed: 6.0,
                }],
                proliferators: Vec::new(),
                technologies: Vec::new(),
            },
            "dyson-receiver-test",
        )
        .unwrap()
    }

    fn fixture_base() -> Value {
        json!({
            "version": 47,
            "mode": "normal",
            "activePlanetId": "home",
            "elapsedSeconds": 0,
            "paused": false,
            "settings": { "productionBufferLimit": 1000 },
            "research": {
                "completedTechIds": ["dirac_inversion", "ray_transmission_1"]
            },
            "endgame": {
                "infiniteResearch": { "stellar_harnessing": { "level": 2 } }
            },
            "galaxy": {
                "systemProfiles": {
                    "helios": { "luminosity": 1.0 },
                    "borealis": { "luminosity": 1.35 }
                }
            },
            "dysonSwarm": {
                "sailsInOrbit": 0,
                "totalLaunched": 0,
                "totalExpired": 0,
                "decayProgress": 0,
                "generationKw": 0,
                "receiverLoadKw": 0,
                "mod:swarm/opaque": { "signedZero": -0.0 }
            },
            "dysonSphere": {
                "structurePoints": 0,
                "totalRocketsLaunched": 0,
                "shellSails": 0,
                "totalSailsAbsorbed": 0,
                "absorptionProgress": 0,
                "generationKw": 0
            },
            "dysonEngineering": {
                "orbitsBySystem": {
                    "helios": [{ "generationKw": 6000000 }],
                    "borealis": [{ "generationKw": 8500000 }]
                }
            },
            "dysonPlans": {
                "helios": { "structurePoints": 1200, "shellSails": 800 },
                "borealis": { "structurePoints": 900, "shellSails": 700 }
            },
            "totalProduced": { "critical_photon": 123 },
            "mod:base/opaque": { "text": "保持原样", "signedZero": -0.0 }
        })
    }

    fn receiver_entity(index: usize) -> Value {
        let mut entity = json!({
            "id": format!("mod:receiver/{index:05}/Ω🚀"),
            "kind": "machine",
            "planetId": if index.is_multiple_of(2) { "home" } else { "ice" },
            "powerGridId": "grid-a",
            "buildingId": "ray_receiver",
            "recipeId": if index.is_multiple_of(3) { "ray_power" } else { "critical_photon" },
            "machineCount": 1 + index % 4,
            "inputs": {},
            "outputs": { "critical_photon": index % 9 },
            "progress": (index % 17) as f64 / 17.0,
            "powerOutputKw": -1,
            "productionRate": -1,
            "utilization": -1,
            "mod:receiver/opaque": {
                "index": index,
                "signedZero": -0.0,
                "text": "保持原样"
            }
        });
        match index % 41 {
            0 => entity["machineCount"] = Value::from(0),
            1 => entity["outputs"]["critical_photon"] = Value::from(400),
            2 => entity["recipeId"] = Value::from("mod:unknown-receiver-recipe"),
            _ => {}
        }
        entity
    }

    fn receiver_matrix(count: usize) -> Vec<Value> {
        (0..count).map(receiver_entity).collect()
    }

    fn non_receiver_entity(index: usize) -> Value {
        json!({
            "id": format!("mod:vein/{index:05}/非接收器"),
            "kind": "vein",
            "planetId": if index.is_multiple_of(2) { "home" } else { "ice" },
            "powerGridId": "grid-a",
            "resourceId": "critical_photon",
            "minerCount": 1,
            "inputs": {},
            "outputs": { "critical_photon": index % 11 },
            "mod:vein/opaque": {
                "index": index,
                "signedZero": -0.0,
                "text": "必须保持原样"
            }
        })
    }

    fn sparse_receiver_matrix(non_receiver_count: usize) -> (Vec<Value>, Vec<usize>) {
        let total = non_receiver_count + 7;
        let receiver_indices = vec![
            0,
            17,
            PARALLEL_MIN_ITEMS - 1,
            PARALLEL_MIN_ITEMS,
            non_receiver_count / 2,
            total - 2,
            total - 1,
        ];
        let entities = (0..total)
            .map(|index| {
                if receiver_indices.binary_search(&index).is_ok() {
                    receiver_entity(index)
                } else {
                    non_receiver_entity(index)
                }
            })
            .collect();
        (entities, receiver_indices)
    }

    fn fixture_state(entities: &[Value]) -> CoreState {
        let entity_count = entities.len();
        let base = serde_json::to_vec(&fixture_base()).unwrap();
        let entities = serde_json::to_vec(entities).unwrap();
        let belts = serde_json::to_vec(&Vec::<Value>::new()).unwrap();
        let chunks = [
            ("base", "base", &base, 0, 1),
            ("entities:00000000", "entities", &entities, 0, entity_count),
            ("belts:00000000", "belts", &belts, 0, 0),
        ]
        .into_iter()
        .map(|(id, kind, bytes, offset, count)| {
            json!({
                "id": id,
                "kind": kind,
                "offset": offset,
                "count": count,
                "checksum": fixture_checksum(bytes),
                "bytes": bytes.len()
            })
        })
        .collect::<Vec<_>>();
        let manifest = serde_json::to_vec(&json!({
            "formatVersion": 1,
            "envelopeFormatVersion": 2,
            "mode": "normal",
            "slot": "main",
            "stateVersion": 47,
            "savedAt": 1,
            "basePrimaryChecksum": "12345678",
            "chunkRootChecksum": "12345678",
            "totalBytes": base.len() + entities.len() + belts.len(),
            "entityCount": entity_count,
            "beltCount": 0,
            "chunks": chunks
        }))
        .unwrap();
        let records = BTreeMap::from([
            (
                "dsp-idle-network.internal.v1.chunked.v1.normal.manifest".to_owned(),
                manifest,
            ),
            (
                "dsp-idle-network.internal.v1.chunked.v1.normal.chunk.base".to_owned(),
                base,
            ),
            (
                "dsp-idle-network.internal.v1.chunked.v1.normal.chunk.entities%3A00000000"
                    .to_owned(),
                entities,
            ),
            (
                "dsp-idle-network.internal.v1.chunked.v1.normal.chunk.belts%3A00000000".to_owned(),
                belts,
            ),
        ]);
        CoreState::from_internal_records(
            CoreCheckpointIdentity {
                slot: "normal-main".to_owned(),
                generation: 1,
                root_hash: "a".repeat(64),
                revision: 7,
                state_version: 47,
                mode: "normal".to_owned(),
                registry_fingerprint: "dyson-receiver-test".to_owned(),
                base_primary_checksum: "12345678".to_owned(),
            },
            &records,
            fixture_catalog(),
        )
        .unwrap()
    }

    fn legacy_calculate_reception(
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
            let system_id =
                system_for_planet(state, text(receiver, "planetId").unwrap_or_default())
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
            let system_id =
                system_for_planet(state, text(receiver, "planetId").unwrap_or_default())
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
        result.receiver_load_kw = receiver_load;
        base.get_mut("dysonSwarm")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native Dyson swarm is missing"))?
            .insert("receiverLoadKw".to_owned(), Value::from(receiver_load));
        Ok(result)
    }

    fn legacy_run_ray_receivers(
        state: &CoreState,
        base: &mut Map<String, Value>,
        entities: &mut [Value],
        seconds: f64,
        credits: &crate::belts::OutputCredits,
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
                + crate::belts::output_credit(state, credits, &entity_id, "critical_photon")
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

    fn run_legacy_receiver_matrix(
        state: &CoreState,
        source: &[Value],
    ) -> (Value, Vec<Value>, Reception) {
        let mut base = fixture_base();
        let base = base.as_object_mut().unwrap();
        let mut entities = source.to_vec();
        let reception = legacy_calculate_reception(state, base, &entities).unwrap();
        legacy_run_ray_receivers(
            state,
            base,
            &mut entities,
            1.75,
            &crate::belts::OutputCredits::default(),
            &reception,
        )
        .unwrap();
        (Value::Object(base.clone()), entities, reception)
    }

    fn run_receiver_matrix(
        state: &CoreState,
        source: &[Value],
        worker_count: usize,
    ) -> (Value, Vec<Value>, Reception) {
        let runtime = DeterministicRuntime::for_test(worker_count);
        let mut base = fixture_base();
        let base = base.as_object_mut().unwrap();
        let mut entities = source.to_vec();
        let reception = calculate_reception_with_runtime(&runtime, state, base, &entities).unwrap();
        run_ray_receivers_with_runtime(
            &runtime,
            state,
            base,
            &mut entities,
            1.75,
            &crate::belts::OutputCredits::default(),
            &reception,
        )
        .unwrap();
        (Value::Object(base.clone()), entities, reception)
    }

    #[test]
    fn ray_receiver_reception_and_settlement_are_byte_exact_at_all_worker_limits() {
        let source = receiver_matrix(PARALLEL_MIN_ITEMS + 257);
        let state = fixture_state(&source);
        let state_hash = state.canonical_sha256().unwrap();
        let legacy = run_legacy_receiver_matrix(&state, &source);
        let baseline = run_receiver_matrix(&state, &source, 1);
        let baseline_bytes = serde_json::to_vec(&(&baseline.0, &baseline.1)).unwrap();
        assert_eq!(
            baseline_bytes,
            serde_json::to_vec(&(&legacy.0, &legacy.1)).unwrap(),
            "parallel probe and stable replay must match the prior serial settlement"
        );
        assert_eq!(
            baseline.2.allocation_by_entity,
            legacy.2.allocation_by_entity
        );
        assert_eq!(
            baseline.2.efficiency_by_entity,
            legacy.2.efficiency_by_entity
        );
        assert_eq!(baseline.2.ray_power_by_entity, legacy.2.ray_power_by_entity);
        assert_eq!(baseline.2.receiver_load_kw, legacy.2.receiver_load_kw);
        let baseline_hash = fixture_checksum(&baseline_bytes);
        assert_eq!(baseline_hash, "8cfa2421");
        assert_eq!(
            baseline.2.receiver_indices,
            (0..source.len()).collect::<Vec<_>>(),
            "settlement index must retain inactive receivers for status reset"
        );
        for worker_count in [2, 4, 8] {
            let observed = run_receiver_matrix(&state, &source, worker_count);
            let observed_bytes = serde_json::to_vec(&(&observed.0, &observed.1)).unwrap();
            assert_eq!(
                fixture_checksum(&observed_bytes),
                baseline_hash,
                "ray receiver state hash diverged for {worker_count} workers"
            );
            assert_eq!(observed_bytes, baseline_bytes);
            assert_eq!(
                observed.2.allocation_by_entity,
                baseline.2.allocation_by_entity
            );
            assert_eq!(
                observed.2.efficiency_by_entity,
                baseline.2.efficiency_by_entity
            );
            assert_eq!(
                observed.2.ray_power_by_entity,
                baseline.2.ray_power_by_entity
            );
            assert_eq!(observed.2.receiver_load_kw, baseline.2.receiver_load_kw);
            assert_eq!(observed.2.receiver_indices, baseline.2.receiver_indices);
        }
        assert_eq!(state.canonical_sha256().unwrap(), state_hash);
        assert!(
            finite(
                baseline
                    .0
                    .get("totalProduced")
                    .and_then(|total| total.get("critical_photon"))
            ) > 123.0
        );
        for (before, after) in source.iter().zip(&baseline.1) {
            assert_eq!(
                serde_json::to_vec(&before["mod:receiver/opaque"]).unwrap(),
                serde_json::to_vec(&after["mod:receiver/opaque"]).unwrap()
            );
        }
        assert_eq!(
            serde_json::to_vec(&fixture_base()["mod:base/opaque"]).unwrap(),
            serde_json::to_vec(&baseline.0["mod:base/opaque"]).unwrap()
        );
    }

    #[test]
    fn sparse_receiver_topology_probes_only_receivers_and_matches_serial_oracle() {
        let (source, expected_receiver_indices) =
            sparse_receiver_matrix(PARALLEL_MIN_ITEMS * 4 + 37);
        let state = fixture_state(&source);
        assert_eq!(
            state.factory_topology.ray_receiver_indices,
            expected_receiver_indices
        );
        assert_eq!(
            state.factory_topology.ray_receiver_indices.capacity(),
            expected_receiver_indices.len(),
            "receiver topology capacity should be trimmed after load"
        );
        assert!(
            state.factory_topology.non_station_indices.len()
                > state.factory_topology.ray_receiver_indices.len() * 2_000
        );

        for worker_count in [1, 2, 4, 8] {
            let probe_count = AtomicUsize::new(0);
            let observed_indices = collect_ordered_receiver_probes_with_runtime(
                &DeterministicRuntime::for_test(worker_count),
                &state.factory_topology.ray_receiver_indices,
                |entity_index| {
                    probe_count.fetch_add(1, AtomicOrdering::SeqCst);
                    Ok(entity_index)
                },
            )
            .unwrap();
            assert_eq!(observed_indices, expected_receiver_indices);
            assert_eq!(
                probe_count.load(AtomicOrdering::SeqCst),
                expected_receiver_indices.len(),
                "discovery work must be O(receivers), worker_count={worker_count}"
            );
        }

        let state_hash = state.canonical_sha256().unwrap();
        let legacy = run_legacy_receiver_matrix(&state, &source);
        let baseline = run_receiver_matrix(&state, &source, 1);
        let baseline_bytes = serde_json::to_vec(&(&baseline.0, &baseline.1)).unwrap();
        let baseline_hash = fixture_checksum(&baseline_bytes);
        assert_eq!(baseline_hash, "8a1a308f");
        assert_eq!(
            baseline_bytes,
            serde_json::to_vec(&(&legacy.0, &legacy.1)).unwrap()
        );
        assert_eq!(
            baseline.2.allocation_by_entity,
            legacy.2.allocation_by_entity
        );
        assert_eq!(
            baseline.2.efficiency_by_entity,
            legacy.2.efficiency_by_entity
        );
        assert_eq!(baseline.2.ray_power_by_entity, legacy.2.ray_power_by_entity);
        assert_eq!(baseline.2.receiver_load_kw, legacy.2.receiver_load_kw);
        assert_eq!(baseline.2.receiver_indices, expected_receiver_indices);

        for worker_count in [2, 4, 8] {
            let observed = run_receiver_matrix(&state, &source, worker_count);
            let observed_bytes = serde_json::to_vec(&(&observed.0, &observed.1)).unwrap();
            assert_eq!(fixture_checksum(&observed_bytes), baseline_hash);
            assert_eq!(observed_bytes, baseline_bytes);
            assert_eq!(
                observed.2.allocation_by_entity,
                baseline.2.allocation_by_entity
            );
            assert_eq!(
                observed.2.efficiency_by_entity,
                baseline.2.efficiency_by_entity
            );
            assert_eq!(
                observed.2.ray_power_by_entity,
                baseline.2.ray_power_by_entity
            );
            assert_eq!(observed.2.receiver_load_kw, baseline.2.receiver_load_kw);
            assert_eq!(observed.2.receiver_indices, baseline.2.receiver_indices);
        }
        assert_eq!(state.canonical_sha256().unwrap(), state_hash);
    }

    #[test]
    fn indexed_receiver_still_applies_runtime_semantic_filtering() {
        let source = receiver_matrix(6);
        let state = fixture_state(&source);
        let stale_index = state.factory_topology.ray_receiver_indices[5];
        let mut runtime_entities = source.clone();
        runtime_entities[stale_index]["kind"] = Value::from("vein");
        runtime_entities[stale_index]["buildingId"] = Value::Null;
        let untouched = serde_json::to_vec(&runtime_entities[stale_index]).unwrap();
        let mut base = fixture_base();
        let reception = calculate_reception_with_runtime(
            &DeterministicRuntime::for_test(8),
            &state,
            base.as_object_mut().unwrap(),
            &runtime_entities,
        )
        .unwrap();
        assert_eq!(reception.receiver_indices, (0..6).collect::<Vec<_>>());
        assert!(
            !reception
                .allocation_by_entity
                .contains_key("mod:receiver/00005/Ω🚀")
        );
        run_ray_receivers_with_runtime(
            &DeterministicRuntime::for_test(8),
            &state,
            base.as_object_mut().unwrap(),
            &mut runtime_entities,
            1.75,
            &crate::belts::OutputCredits::default(),
            &reception,
        )
        .unwrap();
        assert_eq!(
            serde_json::to_vec(&runtime_entities[stale_index]).unwrap(),
            untouched
        );
    }

    #[test]
    fn locked_receiver_resets_progress_without_producing_or_losing_mod_data() {
        let mut source = vec![receiver_entity(5)];
        source[0]["recipeId"] = Value::from("critical_photon");
        source[0]["progress"] = Value::from(0.75);
        let state = fixture_state(&source);
        let mut base = fixture_base();
        base["research"]["completedTechIds"] = json!([]);
        let base = base.as_object_mut().unwrap();
        let original_mod = serde_json::to_vec(&source[0]["mod:receiver/opaque"]).unwrap();
        let reception = calculate_reception_with_runtime(
            &DeterministicRuntime::for_test(8),
            &state,
            base,
            &source,
        )
        .unwrap();
        let mut candidate = source.clone();
        run_ray_receivers_with_runtime(
            &DeterministicRuntime::for_test(8),
            &state,
            base,
            &mut candidate,
            1.75,
            &crate::belts::OutputCredits::default(),
            &reception,
        )
        .unwrap();

        assert_eq!(finite(candidate[0].get("progress")), 0.0);
        assert_eq!(finite(candidate[0].get("productionRate")), 0.0);
        assert_eq!(base["totalProduced"]["critical_photon"], Value::from(123));
        assert_eq!(
            serde_json::to_vec(&candidate[0]["mod:receiver/opaque"]).unwrap(),
            original_mod
        );
    }

    #[test]
    fn receiver_probe_failure_uses_lowest_index_waits_and_keeps_sources_atomic() {
        let mut source = receiver_matrix(PARALLEL_MIN_ITEMS + 97);
        for index in [7, PARALLEL_MIN_ITEMS + 41] {
            source[index]["recipeId"] = Value::from("critical_photon");
            source[index]["machineCount"] = Value::from(2);
            source[index]["planetId"] = Value::from(format!("mod:unknown-planet/{index}"));
            source[index]["outputs"]["critical_photon"] = Value::from(0);
        }
        let state = fixture_state(&source);
        let state_hash = state.canonical_sha256().unwrap();
        let source_bytes = serde_json::to_vec(&source).unwrap();
        let receiver_indices = state.factory_topology.ray_receiver_indices.clone();
        for worker_count in [1, 2, 4, 8] {
            let mut base = fixture_base();
            let base_bytes = serde_json::to_vec(&base).unwrap();
            let later_visited = AtomicBool::new(false);
            let error = collect_ordered_receiver_probes_with_runtime(
                &DeterministicRuntime::for_test(worker_count),
                &receiver_indices,
                |entity_index| {
                    if entity_index == PARALLEL_MIN_ITEMS + 41 {
                        later_visited.store(true, AtomicOrdering::SeqCst);
                    }
                    probe_receiver_reception(
                        &state,
                        base.as_object().unwrap(),
                        &source,
                        entity_index,
                    )
                },
            )
            .unwrap_err();
            assert_eq!(error.to_string(), "native Dyson receiver planet is unknown");
            assert!(later_visited.load(AtomicOrdering::SeqCst));
            assert_eq!(serde_json::to_vec(&source).unwrap(), source_bytes);
            assert_eq!(serde_json::to_vec(&base).unwrap(), base_bytes);
            assert_eq!(state.canonical_sha256().unwrap(), state_hash);

            let error = calculate_reception_with_runtime(
                &DeterministicRuntime::for_test(worker_count),
                &state,
                base.as_object_mut().unwrap(),
                &source,
            )
            .unwrap_err();
            assert_eq!(error.to_string(), "native Dyson receiver planet is unknown");
            assert_eq!(serde_json::to_vec(&base).unwrap(), base_bytes);
        }
    }

    #[test]
    fn ray_receiver_settlement_failure_is_atomic_at_all_worker_limits() {
        let mut source = receiver_matrix(PARALLEL_MIN_ITEMS + 113);
        let first_failure = 7;
        let later_failure = PARALLEL_MIN_ITEMS + 51;
        for index in [first_failure, later_failure] {
            source[index]["recipeId"] = Value::from("critical_photon");
            source[index]["machineCount"] = Value::from(3);
            source[index]["outputs"] = Value::Null;
            source[index]["progress"] = Value::from(0.95);
        }
        let state = fixture_state(&source);
        let state_hash = state.canonical_sha256().unwrap();
        for worker_count in [1, 2, 4, 8] {
            let runtime = DeterministicRuntime::for_test(worker_count);
            let mut base = fixture_base();
            let base = base.as_object_mut().unwrap();
            let reception =
                calculate_reception_with_runtime(&runtime, &state, base, &source).unwrap();
            let mut candidate = source.clone();
            let candidate_bytes = serde_json::to_vec(&candidate).unwrap();
            let base_bytes = serde_json::to_vec(&base).unwrap();
            let later_visited = AtomicBool::new(false);
            let environment = RayReceiverSettlementEnvironment {
                state: &state,
                base,
                entities: &candidate,
                seconds: 1.75,
                credits: &crate::belts::OutputCredits::default(),
                reception: &reception,
            };
            let error = collect_ordered_receiver_probes_with_runtime(
                &runtime,
                &reception.receiver_indices,
                |entity_index| {
                    if entity_index == later_failure {
                        later_visited.store(true, AtomicOrdering::SeqCst);
                    }
                    probe_ray_receiver_settlement(&environment, entity_index)
                },
            )
            .unwrap_err();
            assert_eq!(error.to_string(), "native ray receiver outputs are missing");
            assert!(later_visited.load(AtomicOrdering::SeqCst));
            let error = run_ray_receivers_with_runtime(
                &runtime,
                &state,
                base,
                &mut candidate,
                1.75,
                &crate::belts::OutputCredits::default(),
                &reception,
            )
            .unwrap_err();
            assert_eq!(error.to_string(), "native ray receiver outputs are missing");
            assert_eq!(serde_json::to_vec(&candidate).unwrap(), candidate_bytes);
            assert_eq!(serde_json::to_vec(&base).unwrap(), base_bytes);
            assert_eq!(state.canonical_sha256().unwrap(), state_hash);
        }
    }

    #[test]
    fn small_receiver_probe_batches_stay_serial_and_ordered() {
        let indices = (0..31).collect::<Vec<_>>();
        let saw_rayon_worker = AtomicBool::new(false);
        let observed = collect_ordered_receiver_probes_with_runtime(
            &DeterministicRuntime::for_test(8),
            &indices,
            |entity_index| {
                if rayon::current_thread_index().is_some() {
                    saw_rayon_worker.store(true, AtomicOrdering::SeqCst);
                }
                Ok(entity_index)
            },
        )
        .unwrap();
        assert_eq!(observed, indices);
        assert!(!saw_rayon_worker.load(AtomicOrdering::SeqCst));
    }
}
