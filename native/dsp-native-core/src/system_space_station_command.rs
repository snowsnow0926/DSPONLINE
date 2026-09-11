//! Pure, two-phase player commands for the built-in system space station.
//!
//! This module deliberately does not own a receipt store or a renderer
//! protocol.  It proves one request against one authoritative CORE revision,
//! expands it into the ordinary durable patch format, and exposes the exact
//! `(command_id, semantic_sha256)` binding a Host must persist for replay
//! idempotency.  The same prepared value is re-proved immediately before
//! apply, so a stale session, run, registry or revision cannot cross the
//! prepare/apply boundary.

use std::collections::{BTreeMap, BTreeSet};

use anyhow::{Context, anyhow, bail};
use num_bigint::BigUint;
use num_traits::{One, Zero};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::command::{
    EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT, PathSegment, RecordPatch, SimulationCommandPatch,
    ValuePatch, builtin_belt_construction_id,
};
use crate::{CORE_PROTOCOL_VERSION, CommandApplyResult, CoreState};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_COMMAND_TEXT_BYTES: usize = 256;
const MAX_HUB_DIGITS: usize = 256;
const MAX_MODULE_COUNT: u32 = 1_000_000;
const OUTPUT_PORTS: usize = 5;

const STATION_ENGINEERING: &str = "system_space_station_engineering";
const MODULAR_ASSEMBLY: &str = "orbital_modular_assembly";
const AUTONOMOUS_CONSTRUCTION: &str = "autonomous_station_construction";
const QUANTUM_LOGISTICS: &str = "quantum_logistics_network";
const HISTORICAL_ELEVATOR: &str = "orbital_elevator_engineering";
const MULTI_CARGO_BUS: &str = "orbital_multi_cargo_bus";

const STATION_PHASES: &[(&str, &str, u64)] = &[
    ("orbital-base", "titanium_alloy", 1_000_000),
    ("orbital-base", "frame_material", 500_000),
    ("orbital-base", "small_carrier_rocket", 100_000),
    ("orbital-base", "universe_matrix", 100_000),
    ("main-frame", "frame_material", 2_000_000),
    ("main-frame", "dyson_sphere_component", 1_000_000),
    ("main-frame", "titanium_glass", 1_000_000),
    ("main-frame", "quantum_chip", 500_000),
    ("energy-core", "antimatter_fuel_rod", 250_000),
    ("energy-core", "annihilation_constraint_sphere", 500_000),
    ("energy-core", "strange_matter", 1_000_000),
    ("energy-core", "plane_filter", 1_000_000),
    ("dispatch-core", "processor", 5_000_000),
    ("dispatch-core", "particle_broadband", 2_000_000),
    ("dispatch-core", "quantum_chip", 2_000_000),
    ("dispatch-core", "universe_matrix", 1_000_000),
];

const BACKBONE_COSTS: &[(&str, u64)] = &[
    ("frame_material", 100_000),
    ("quantum_chip", 50_000),
    ("processor", 100_000),
    ("universe_matrix", 10_000),
];
const ENERGY_COSTS: &[(&str, u64)] = &[
    ("antimatter_fuel_rod", 50_000),
    ("annihilation_constraint_sphere", 50_000),
    ("strange_matter", 100_000),
    ("quantum_chip", 50_000),
];
const INTERSTELLAR_COSTS: &[(&str, u64)] = &[
    ("titanium_alloy", 100_000),
    ("frame_material", 50_000),
    ("particle_container", 100_000),
    ("space_warper", 10_000),
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemSpaceStationAuthority {
    pub session_id: String,
    pub run_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SystemSpaceStationModule {
    Backbone,
    Energy,
    Interstellar,
}

impl SystemSpaceStationModule {
    fn key(self) -> &'static str {
        match self {
            Self::Backbone => "backbone",
            Self::Energy => "energy",
            Self::Interstellar => "interstellar",
        }
    }

    fn costs(self) -> &'static [(&'static str, u64)] {
        match self {
            Self::Backbone => BACKBONE_COSTS,
            Self::Energy => ENERGY_COSTS,
            Self::Interstellar => INTERSTELLAR_COSTS,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum InterstellarStationMode {
    Legacy,
    Elevator,
}

impl InterstellarStationMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Legacy => "legacy",
            Self::Elevator => "elevator",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum SystemSpaceStationIntent {
    Start {
        system_id: String,
    },
    DeliverFromTray {
        system_id: String,
        planet_id: String,
        item_id: String,
        requested_amount: u64,
    },
    ModuleTarget {
        system_id: String,
        module: SystemSpaceStationModule,
        target: u32,
    },
    UpgradeOne {
        entity_id: String,
    },
    UpgradeAll {
        system_id: Option<String>,
    },
    ModeTarget {
        entity_id: String,
        mode: InterstellarStationMode,
    },
    OutputTarget {
        entity_id: String,
        port_index: u8,
        item_id: Option<String>,
        confirmations: u8,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemSpaceStationCommandRequest {
    pub command_id: String,
    pub session_id: String,
    pub run_id: String,
    pub expected_revision: u64,
    pub expected_registry_fingerprint: String,
    pub intent: SystemSpaceStationIntent,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemSpaceStationIdempotencyBinding {
    pub command_id: String,
    pub semantic_sha256: String,
    pub session_id: String,
    pub run_id: String,
    pub expected_revision: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SystemSpaceStationIdempotencyDecision {
    NewCommand,
    ReplayRecordedResult,
}

/// Pure receipt classification for the Host's durable command-ID table.
///
/// The caller supplies the receipt currently stored under the proposed
/// command ID. An exact semantic/context match is a replay; reusing the ID for
/// any other payload is a hard collision and must never execute again.
pub fn classify_system_space_station_idempotency(
    recorded: Option<&SystemSpaceStationIdempotencyBinding>,
    proposed: &SystemSpaceStationIdempotencyBinding,
) -> anyhow::Result<SystemSpaceStationIdempotencyDecision> {
    let Some(recorded) = recorded else {
        return Ok(SystemSpaceStationIdempotencyDecision::NewCommand);
    };
    if recorded.command_id != proposed.command_id {
        bail!("native system-space-station receipt lookup returned another command ID")
    }
    if recorded == proposed {
        return Ok(SystemSpaceStationIdempotencyDecision::ReplayRecordedResult);
    }
    bail!("native system-space-station command ID was reused with another semantic payload")
}

#[derive(Debug, Clone)]
pub struct PreparedSystemSpaceStationCommand {
    request: SystemSpaceStationCommandRequest,
    base_sha256: String,
    semantic_sha256: String,
    patch_sha256: String,
    patch: SimulationCommandPatch,
}

impl PreparedSystemSpaceStationCommand {
    pub fn patch(&self) -> &SimulationCommandPatch {
        &self.patch
    }

    pub fn idempotency_binding(&self) -> SystemSpaceStationIdempotencyBinding {
        SystemSpaceStationIdempotencyBinding {
            command_id: self.request.command_id.clone(),
            semantic_sha256: self.semantic_sha256.clone(),
            session_id: self.request.session_id.clone(),
            run_id: self.request.run_id.clone(),
            expected_revision: self.request.expected_revision,
        }
    }

    /// Re-proves the complete request against the current authoritative state
    /// and commits only the already-proved generic patch. A Host receipt store
    /// should return the prior result for an identical idempotency binding and
    /// reject the same command ID with a different semantic hash.
    pub fn apply(
        &self,
        state: &mut CoreState,
        authority: &SystemSpaceStationAuthority,
    ) -> anyhow::Result<CommandApplyResult> {
        let current = prepare_system_space_station_command(state, authority, self.request.clone())?;
        if current.base_sha256 != self.base_sha256
            || current.semantic_sha256 != self.semantic_sha256
            || current.patch_sha256 != self.patch_sha256
        {
            bail!("native system-space-station command changed after prepare")
        }
        state.apply_command(&self.patch)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SemanticRequest<'a> {
    session_id: &'a str,
    run_id: &'a str,
    expected_revision: u64,
    expected_registry_fingerprint: &'a str,
    intent: &'a SystemSpaceStationIntent,
}

pub fn prepare_system_space_station_command(
    state: &CoreState,
    authority: &SystemSpaceStationAuthority,
    request: SystemSpaceStationCommandRequest,
) -> anyhow::Result<PreparedSystemSpaceStationCommand> {
    valid_command_text("command ID", &request.command_id)?;
    valid_command_text("session ID", &request.session_id)?;
    valid_command_text("run ID", &request.run_id)?;
    valid_command_text("current session ID", &authority.session_id)?;
    valid_command_text("current run ID", &authority.run_id)?;
    if request.session_id != authority.session_id {
        bail!("native system-space-station command session is stale")
    }
    if request.run_id != authority.run_id {
        bail!("native system-space-station command run is stale")
    }
    if request.expected_revision > MAX_SAFE_INTEGER || request.expected_revision != state.revision {
        bail!("native system-space-station command revision is stale")
    }
    if request.expected_registry_fingerprint != state.identity.registry_fingerprint
        || request.expected_registry_fingerprint != state.catalog.snapshot.registry_fingerprint
    {
        bail!("native system-space-station command registry is stale")
    }
    if request.expected_registry_fingerprint != EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT {
        bail!("native system-space-station command registry is outside the built-in domain")
    }
    if state.identity.state_version != 47 {
        bail!("native system-space-station command requires GameState v47")
    }

    let patch = build_patch(state, &request.intent)?;
    let semantic_sha256 = sha256_json(&SemanticRequest {
        session_id: &request.session_id,
        run_id: &request.run_id,
        expected_revision: request.expected_revision,
        expected_registry_fingerprint: &request.expected_registry_fingerprint,
        intent: &request.intent,
    })?;
    let patch_sha256 = sha256_json(&patch)?;
    Ok(PreparedSystemSpaceStationCommand {
        request,
        base_sha256: state.canonical_sha256()?,
        semantic_sha256,
        patch_sha256,
        patch,
    })
}

fn build_patch(
    state: &CoreState,
    intent: &SystemSpaceStationIntent,
) -> anyhow::Result<SimulationCommandPatch> {
    match intent {
        SystemSpaceStationIntent::Start { system_id } => start_patch(state, system_id),
        SystemSpaceStationIntent::DeliverFromTray {
            system_id,
            planet_id,
            item_id,
            requested_amount,
        } => delivery_patch(state, system_id, planet_id, item_id, *requested_amount),
        SystemSpaceStationIntent::ModuleTarget {
            system_id,
            module,
            target,
        } => module_patch(state, system_id, *module, *target),
        SystemSpaceStationIntent::UpgradeOne { entity_id } => {
            upgrade_patch(state, Some(entity_id), None)
        }
        SystemSpaceStationIntent::UpgradeAll { system_id } => {
            upgrade_patch(state, None, system_id.as_deref())
        }
        SystemSpaceStationIntent::ModeTarget { entity_id, mode } => {
            mode_patch(state, entity_id, *mode)
        }
        SystemSpaceStationIntent::OutputTarget {
            entity_id,
            port_index,
            item_id,
            confirmations,
        } => output_patch(
            state,
            entity_id,
            *port_index,
            item_id.as_deref(),
            *confirmations,
        ),
    }
}

fn empty_patch(state: &CoreState) -> SimulationCommandPatch {
    SimulationCommandPatch {
        protocol_version: CORE_PROTOCOL_VERSION,
        base_revision: state.revision,
        top_level_changes: Vec::new(),
        changed_entities: Vec::new(),
        added_entities: Vec::new(),
        removed_entity_ids: Vec::new(),
        changed_belts: Vec::new(),
        added_belts: Vec::new(),
        removed_belt_ids: Vec::new(),
    }
}

fn set_top(path: &[&str], value: Value) -> ValuePatch {
    ValuePatch {
        path: path
            .iter()
            .map(|value| PathSegment::Key((*value).to_owned()))
            .collect(),
        operation: "set".to_owned(),
        value: Some(value),
    }
}

fn replace_record(id: &str, value: Value) -> RecordPatch {
    RecordPatch {
        id: id.to_owned(),
        changes: vec![ValuePatch {
            path: Vec::new(),
            operation: "set".to_owned(),
            value: Some(value),
        }],
    }
}

fn start_patch(state: &CoreState, system_id: &str) -> anyhow::Result<SimulationCommandPatch> {
    valid_domain_id("system ID", system_id)?;
    ensure_system(state, system_id)?;
    let research = completed_techs(state)?;
    if !research.contains(STATION_ENGINEERING) {
        bail!("native system-space-station construction technology is missing")
    }
    let unlocked = state
        .base_value()
        .get("exploration")
        .and_then(Value::as_object)
        .and_then(|value| value.get("unlockedSystemIds"))
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("native system-space-station exploration state is invalid"))?;
    if !unlocked
        .iter()
        .any(|value| value.as_str() == Some(system_id))
    {
        bail!("native system-space-station system is locked")
    }
    let has_launcher = (0..state.entities.kinds.len()).try_fold(
        false,
        |found, index| -> anyhow::Result<bool> {
            if found {
                return Ok(true);
            }
            let entity = state.parse_entity(index)?;
            let entity = entity
                .as_object()
                .ok_or_else(|| anyhow!("native system-space-station entity is invalid"))?;
            if string_field(entity, "buildingId")? != "space_station_construction_launcher" {
                return Ok(false);
            }
            let planet_id = string_field(entity, "planetId")?;
            Ok(planet_system(state, planet_id)? == system_id)
        },
    )?;
    if !has_launcher {
        bail!("native system-space-station construction launcher is missing")
    }

    let mut station = station_value_or_default(state, system_id)?;
    let object = station
        .as_object_mut()
        .ok_or_else(|| anyhow!("native system-space-station record is invalid"))?;
    validate_station_identity(object, system_id)?;
    if string_field(object, "status")? != "not-started" {
        bail!("native system-space-station construction is not startable")
    }
    let revision = strict_safe_u64(object.get("costRevision"), "station cost revision")?;
    let next_revision = revision
        .checked_add(1)
        .filter(|value| *value <= MAX_SAFE_INTEGER)
        .ok_or_else(|| anyhow!("native system-space-station cost revision overflow"))?;
    let multiplier = if research.contains(AUTONOMOUS_CONSTRUCTION) {
        8_000
    } else if research.contains(MODULAR_ASSEMBLY) {
        9_000
    } else {
        10_000
    };
    object.insert("status".to_owned(), Value::String("building".to_owned()));
    object.insert("costRevision".to_owned(), Value::from(next_revision));
    object.insert(
        "costMultiplierBasisPoints".to_owned(),
        Value::from(multiplier),
    );
    object.insert("phaseIndex".to_owned(), Value::from(0));
    object.insert("delivered".to_owned(), Value::Object(Map::new()));
    object.insert("constructionBuffer".to_owned(), Value::Object(Map::new()));
    object.insert("inventory".to_owned(), Value::Object(Map::new()));

    let mut patch = empty_patch(state);
    patch
        .top_level_changes
        .push(set_top(&["systemSpaceStations", system_id], station));
    Ok(patch)
}

fn delivery_patch(
    state: &CoreState,
    system_id: &str,
    planet_id: &str,
    item_id: &str,
    requested_amount: u64,
) -> anyhow::Result<SimulationCommandPatch> {
    valid_domain_id("system ID", system_id)?;
    valid_domain_id("planet ID", planet_id)?;
    valid_domain_id("item ID", item_id)?;
    if requested_amount == 0 || requested_amount > MAX_SAFE_INTEGER {
        bail!("native system-space-station delivery amount is invalid")
    }
    ensure_item(state, item_id)?;
    if planet_system(state, planet_id)? != system_id {
        bail!("native system-space-station delivery planet is outside the system")
    }
    let mut station = station_value(state, system_id)?;
    let station_object = station
        .as_object_mut()
        .ok_or_else(|| anyhow!("native system-space-station record is invalid"))?;
    validate_station_identity(station_object, system_id)?;
    if string_field(station_object, "status")? != "building" {
        bail!("native system-space-station delivery is not applicable")
    }
    let multiplier = strict_safe_u64(
        station_object.get("costMultiplierBasisPoints"),
        "station cost multiplier",
    )?;
    if !(8_000..=10_000).contains(&multiplier) {
        bail!("native system-space-station cost multiplier is invalid")
    }
    let phase_index = strict_safe_u64(station_object.get("phaseIndex"), "station phase index")?;
    if phase_index as usize > STATION_PHASES.len() {
        bail!("native system-space-station phase index is invalid")
    }
    let requirement = STATION_PHASES
        .iter()
        .enumerate()
        .find(|(index, (_, candidate, _))| *index >= phase_index as usize && *candidate == item_id)
        .ok_or_else(|| {
            anyhow!("native system-space-station item is not required in a remaining phase")
        })?;
    let required = required_amount(requirement.1.2, multiplier);

    let trays = state
        .base_value()
        .get("planetTrays")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native system-space-station planet trays are invalid"))?;
    let mut tray = trays
        .get(planet_id)
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()));
    let tray_object = tray
        .as_object_mut()
        .ok_or_else(|| anyhow!("native system-space-station planet tray is invalid"))?;
    let available = optional_safe_u64(tray_object.get(item_id), "planet tray amount")?;

    let delivered = decimal_map(station_object.get("delivered"), "station delivered")?;
    let current = delivered
        .get(item_id)
        .cloned()
        .unwrap_or_else(BigUint::zero);
    let remaining = required.saturating_sub(&current);
    let moved = BigUint::from(available.min(requested_amount)).min(remaining);
    if moved.is_zero() {
        bail!("native system-space-station delivery has no movable material")
    }
    let moved_u64: u64 = moved.clone().try_into().map_err(|_| {
        anyhow!("native system-space-station delivery exceeds the safe integer domain")
    })?;

    let mut buffer = decimal_map(
        station_object.get("constructionBuffer"),
        "station construction buffer",
    )?;
    add_decimal_exact(&mut buffer, item_id, &moved)?;
    station_object.insert("constructionBuffer".to_owned(), decimal_map_value(&buffer));
    apply_construction_buffer(station_object)?;

    tray_object.insert(item_id.to_owned(), Value::from(available - moved_u64));
    let mut patch = empty_patch(state);
    patch
        .top_level_changes
        .push(set_top(&["systemSpaceStations", system_id], station));
    patch
        .top_level_changes
        .push(set_top(&["planetTrays", planet_id], tray.clone()));
    if state
        .base_value()
        .get("activePlanetId")
        .and_then(Value::as_str)
        == Some(planet_id)
    {
        patch.top_level_changes.push(set_top(&["tray"], tray));
    }
    Ok(patch)
}

fn module_patch(
    state: &CoreState,
    system_id: &str,
    module: SystemSpaceStationModule,
    target: u32,
) -> anyhow::Result<SimulationCommandPatch> {
    valid_domain_id("system ID", system_id)?;
    ensure_system(state, system_id)?;
    if target > MAX_MODULE_COUNT {
        bail!("native system-space-station module target is invalid")
    }
    let mut station = station_value(state, system_id)?;
    let station_object = station
        .as_object_mut()
        .ok_or_else(|| anyhow!("native system-space-station record is invalid"))?;
    validate_station_identity(station_object, system_id)?;
    if string_field(station_object, "status")? != "operational" {
        bail!("native system-space-station module target is not applicable")
    }
    let modules = station_object
        .get("modules")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native system-space-station modules are invalid"))?;
    let current = strict_safe_u64(modules.get(module.key()), "station module count")?;
    if current > MAX_MODULE_COUNT as u64 {
        bail!("native system-space-station module count is invalid")
    }
    if current == target as u64 {
        bail!("native system-space-station module target is unchanged")
    }
    let mut inventory = decimal_map(station_object.get("inventory"), "station inventory")?;
    let (range_start, amount) = if target as u64 > current {
        (current, target as u64 - current)
    } else {
        (target as u64, current - target as u64)
    };
    let mut costs = Vec::with_capacity(module.costs().len());
    for (item_id, base) in module.costs() {
        ensure_item(state, item_id)?;
        costs.push((
            *item_id,
            escalating_cost(BigUint::from(*base), range_start, amount),
        ));
    }
    if target as u64 > current {
        for (item_id, cost) in &costs {
            let available = inventory
                .get(*item_id)
                .cloned()
                .unwrap_or_else(BigUint::zero);
            if available < *cost {
                bail!("native system-space-station module inventory is insufficient")
            }
        }
        for (item_id, cost) in costs {
            subtract_decimal_exact(&mut inventory, item_id, &cost)?;
        }
    } else {
        for (item_id, cost) in costs {
            add_decimal_saturated(&mut inventory, item_id, &(cost / 2u8));
        }
    }
    station_object
        .get_mut("modules")
        .and_then(Value::as_object_mut)
        .expect("station modules were proved above")
        .insert(module.key().to_owned(), Value::from(target));
    station_object.insert("inventory".to_owned(), decimal_map_value(&inventory));
    let mut patch = empty_patch(state);
    patch
        .top_level_changes
        .push(set_top(&["systemSpaceStations", system_id], station));
    Ok(patch)
}

fn upgrade_patch(
    state: &CoreState,
    one_entity_id: Option<&str>,
    system_filter: Option<&str>,
) -> anyhow::Result<SimulationCommandPatch> {
    if let Some(entity_id) = one_entity_id {
        valid_domain_id("entity ID", entity_id)?;
    }
    if let Some(system_id) = system_filter {
        valid_domain_id("system ID", system_id)?;
        ensure_system(state, system_id)?;
    }
    let techs = completed_techs(state)?;
    if !techs.contains(QUANTUM_LOGISTICS) && !techs.contains(HISTORICAL_ELEVATOR) {
        bail!("native interstellar-station upgrade technology is missing")
    }

    let mut candidates = Vec::new();
    if let Some(entity_id) = one_entity_id {
        let index = *state
            .entity_index
            .get(entity_id)
            .ok_or_else(|| anyhow!("native interstellar-station upgrade target is missing"))?;
        candidates.push((entity_id.to_owned(), state.parse_entity(index)?));
    } else {
        for index in 0..state.entities.kinds.len() {
            let value = state.parse_entity(index)?;
            let object = value
                .as_object()
                .ok_or_else(|| anyhow!("native interstellar-station entity is invalid"))?;
            if string_field(object, "buildingId")? != "interstellar_logistics_station" {
                continue;
            }
            if let Some(system_id) = system_filter
                && planet_system(state, string_field(object, "planetId")?)? != system_id
            {
                continue;
            }
            candidates.push((string_field(object, "id")?.to_owned(), value));
        }
        candidates.sort_by(|left, right| left.0.cmp(&right.0));
    }

    let mut changed_entities = Vec::new();
    let mut output_items_by_station = BTreeMap::<String, Vec<Option<String>>>::new();
    for (entity_id, mut value) in candidates {
        let object = value
            .as_object_mut()
            .ok_or_else(|| anyhow!("native interstellar-station entity is invalid"))?;
        let eligible = upgrade_eligibility(state, object, one_entity_id.is_some())?;
        if !eligible {
            continue;
        }
        let output_items = elevator_output_items(state, object, true)?;
        object.insert("stationTier".to_owned(), Value::from(2));
        let mode = match object.get("stationOperationMode") {
            None | Some(Value::Null) => "legacy".to_owned(),
            Some(Value::String(value)) if value == "legacy" || value == "elevator" => value.clone(),
            _ => bail!("native interstellar-station operation mode is invalid"),
        };
        object.insert("stationOperationMode".to_owned(), Value::String(mode));
        object.insert("stationModeTransition".to_owned(), Value::Null);
        object.insert(
            "elevatorOutputItems".to_owned(),
            Value::Array(
                output_items
                    .iter()
                    .map(|value| value.clone().map(Value::String).unwrap_or(Value::Null))
                    .collect(),
            ),
        );
        output_items_by_station.insert(entity_id.clone(), output_items);
        changed_entities.push(replace_record(&entity_id, value));
    }
    if changed_entities.is_empty() {
        bail!("native interstellar-station upgrade has no eligible target")
    }

    let mut changed_belts = Vec::new();
    for index in 0..state.belts.ids.len() {
        let mut value = state.parse_belt(index)?;
        let object = value
            .as_object_mut()
            .ok_or_else(|| anyhow!("native interstellar-station belt is invalid"))?;
        if object.contains_key("elevatorOutputIndex") {
            continue;
        }
        let source = string_field(object, "source")?;
        let Some(outputs) = output_items_by_station.get(source) else {
            continue;
        };
        let item_id = string_field(object, "itemId")?;
        if let Some(index) = outputs
            .iter()
            .position(|candidate| candidate.as_deref() == Some(item_id))
        {
            object.insert("elevatorOutputIndex".to_owned(), Value::from(index));
            let belt_id = string_field(object, "id")?.to_owned();
            changed_belts.push(replace_record(&belt_id, value));
        }
    }
    changed_entities.sort_by(|left, right| left.id.cmp(&right.id));
    changed_belts.sort_by(|left, right| left.id.cmp(&right.id));
    let mut patch = empty_patch(state);
    patch.changed_entities = changed_entities;
    patch.changed_belts = changed_belts;
    Ok(patch)
}

fn mode_patch(
    state: &CoreState,
    entity_id: &str,
    mode: InterstellarStationMode,
) -> anyhow::Result<SimulationCommandPatch> {
    valid_domain_id("entity ID", entity_id)?;
    if mode == InterstellarStationMode::Elevator
        && !completed_techs(state)?.contains(MULTI_CARGO_BUS)
    {
        bail!("native interstellar-station elevator technology is missing")
    }
    let index = *state
        .entity_index
        .get(entity_id)
        .ok_or_else(|| anyhow!("native interstellar-station mode target is missing"))?;
    let mut value = state.parse_entity(index)?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| anyhow!("native interstellar-station entity is invalid"))?;
    require_interstellar_station(object)?;
    if strict_safe_u64(object.get("stationTier"), "interstellar-station tier")? != 2 {
        bail!("native interstellar-station mode target requires Mk.II")
    }
    let current = optional_mode(object.get("stationOperationMode"))?;
    let transition = match object.get("stationModeTransition") {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) if value == "to-elevator" || value == "to-legacy" => {
            Some(value.as_str())
        }
        _ => bail!("native interstellar-station mode transition is invalid"),
    };
    if current == mode.as_str() && transition.is_none() {
        bail!("native interstellar-station mode target is unchanged")
    }
    object.insert(
        "stationModeTransition".to_owned(),
        Value::String(
            match mode {
                InterstellarStationMode::Legacy => "to-legacy",
                InterstellarStationMode::Elevator => "to-elevator",
            }
            .to_owned(),
        ),
    );
    let outputs = elevator_output_items(state, object, false)?;
    let mut patch = empty_patch(state);
    patch
        .changed_entities
        .push(replace_record(entity_id, value));
    if mode == InterstellarStationMode::Elevator {
        for belt_index in 0..state.belts.ids.len() {
            let mut belt = state.parse_belt(belt_index)?;
            let belt_object = belt
                .as_object_mut()
                .ok_or_else(|| anyhow!("native interstellar-station belt is invalid"))?;
            if string_field(belt_object, "source")? != entity_id
                || belt_object.contains_key("elevatorOutputIndex")
            {
                continue;
            }
            let item_id = string_field(belt_object, "itemId")?;
            if let Some(index) = outputs
                .iter()
                .position(|candidate| candidate.as_deref() == Some(item_id))
            {
                belt_object.insert("elevatorOutputIndex".to_owned(), Value::from(index));
                let belt_id = string_field(belt_object, "id")?.to_owned();
                patch.changed_belts.push(replace_record(&belt_id, belt));
            }
        }
        patch
            .changed_belts
            .sort_by(|left, right| left.id.cmp(&right.id));
    }
    Ok(patch)
}

fn output_patch(
    state: &CoreState,
    entity_id: &str,
    port_index: u8,
    item_id: Option<&str>,
    confirmations: u8,
) -> anyhow::Result<SimulationCommandPatch> {
    valid_domain_id("entity ID", entity_id)?;
    if port_index as usize >= OUTPUT_PORTS {
        bail!("native interstellar-station output port is invalid")
    }
    if confirmations < 2 {
        bail!("native interstellar-station output change is not confirmed")
    }
    if let Some(item_id) = item_id {
        valid_domain_id("item ID", item_id)?;
        ensure_item(state, item_id)?;
    }
    let index = *state
        .entity_index
        .get(entity_id)
        .ok_or_else(|| anyhow!("native interstellar-station output target is missing"))?;
    let mut entity = state.parse_entity(index)?;
    let object = entity
        .as_object_mut()
        .ok_or_else(|| anyhow!("native interstellar-station entity is invalid"))?;
    require_interstellar_station(object)?;
    if strict_safe_u64(object.get("stationTier"), "interstellar-station tier")? != 2
        || optional_mode(object.get("stationOperationMode"))? != "elevator"
    {
        bail!("native interstellar-station output target is not applicable")
    }
    let mut outputs = elevator_output_items(state, object, false)?;
    if let Some(item_id) = item_id
        && outputs
            .iter()
            .enumerate()
            .any(|(index, value)| index != port_index as usize && value.as_deref() == Some(item_id))
    {
        bail!("native interstellar-station output item is duplicated")
    }
    let previous = outputs[port_index as usize].clone();
    outputs[port_index as usize] = item_id.map(str::to_owned);

    let mut removed_ids = Vec::new();
    let mut refunds = BTreeMap::<String, u64>::new();
    for belt_index in 0..state.belts.ids.len() {
        let belt = state.parse_belt(belt_index)?;
        let belt_object = belt
            .as_object()
            .ok_or_else(|| anyhow!("native interstellar-station belt is invalid"))?;
        if string_field(belt_object, "source")? != entity_id {
            continue;
        }
        let assigned = match belt_object.get("elevatorOutputIndex") {
            None => None,
            Some(value) => Some(strict_safe_u64(Some(value), "belt elevator output index")?),
        };
        let legacy_match = assigned.is_none()
            && previous.is_some()
            && previous.as_deref() == Some(string_field(belt_object, "itemId")?);
        if assigned != Some(port_index as u64) && !legacy_match {
            continue;
        }
        let tier = strict_safe_u64(belt_object.get("tier"), "belt tier")?;
        let tier =
            u8::try_from(tier).context("native interstellar-station belt tier is invalid")?;
        let construction_id = builtin_belt_construction_id(state, tier)?;
        let lanes = belt_object
            .get("lanes")
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite() && *value <= MAX_SAFE_INTEGER as f64)
            .ok_or_else(|| anyhow!("native interstellar-station belt lanes are invalid"))?;
        let lanes = lanes.floor().max(1.0) as u64;
        let next = refunds
            .get(construction_id)
            .copied()
            .unwrap_or(0)
            .checked_add(lanes)
            .filter(|value| *value <= MAX_SAFE_INTEGER)
            .ok_or_else(|| anyhow!("native interstellar-station belt refund overflow"))?;
        refunds.insert(construction_id.to_owned(), next);
        removed_ids.push(string_field(belt_object, "id")?.to_owned());
    }
    if outputs[port_index as usize] == previous && removed_ids.is_empty() {
        bail!("native interstellar-station output target is unchanged")
    }

    object.insert(
        "elevatorOutputItems".to_owned(),
        Value::Array(
            outputs
                .into_iter()
                .map(|value| value.map(Value::String).unwrap_or(Value::Null))
                .collect(),
        ),
    );
    let mut patch = empty_patch(state);
    patch
        .changed_entities
        .push(replace_record(entity_id, entity));
    patch.removed_belt_ids = removed_ids;
    patch.removed_belt_ids.sort();
    if !refunds.is_empty() {
        let construction = state
            .base_value()
            .get("construction")
            .and_then(Value::as_object)
            .ok_or_else(|| anyhow!("native construction inventory is invalid"))?;
        for (construction_id, refund) in refunds {
            let existing = optional_safe_u64(
                construction.get(&construction_id),
                "construction inventory amount",
            )?;
            let updated = existing
                .checked_add(refund)
                .filter(|value| *value <= MAX_SAFE_INTEGER)
                .ok_or_else(|| anyhow!("native construction inventory refund overflow"))?;
            patch.top_level_changes.push(set_top(
                &["construction", &construction_id],
                Value::from(updated),
            ));
        }
    }
    Ok(patch)
}

fn upgrade_eligibility(
    state: &CoreState,
    object: &Map<String, Value>,
    strict_target: bool,
) -> anyhow::Result<bool> {
    if string_field(object, "buildingId")? != "interstellar_logistics_station" {
        if strict_target {
            bail!("native interstellar-station upgrade target has the wrong building type")
        }
        return Ok(false);
    }
    let tier = match object.get("stationTier") {
        None | Some(Value::Null) => 1,
        value => strict_safe_u64(value, "interstellar-station tier")?,
    };
    if tier >= 2 {
        if strict_target {
            bail!("native interstellar-station upgrade target is already Mk.II")
        }
        return Ok(false);
    }
    let machine_count = strict_safe_u64(object.get("machineCount"), "station machine count")?;
    if machine_count < 1 {
        if strict_target {
            bail!("native interstellar-station machine count is invalid")
        }
        return Ok(false);
    }
    // Current 1.2.x semantics intentionally make the upgrade an access-mode
    // change. Its persisted legacy cost shape is all zero, so no tray debit is
    // fabricated here.
    let _ = state;
    Ok(true)
}

fn require_interstellar_station(object: &Map<String, Value>) -> anyhow::Result<()> {
    if string_field(object, "buildingId")? != "interstellar_logistics_station" {
        bail!("native interstellar-station command target has the wrong building type")
    }
    Ok(())
}

fn elevator_output_items(
    state: &CoreState,
    object: &Map<String, Value>,
    derive_from_station_slots: bool,
) -> anyhow::Result<Vec<Option<String>>> {
    if let Some(value) = object
        .get("elevatorOutputItems")
        .filter(|value| !value.is_null())
    {
        let values = value
            .as_array()
            .ok_or_else(|| anyhow!("native interstellar-station output items are invalid"))?;
        if values.len() != OUTPUT_PORTS {
            bail!("native interstellar-station output item count is invalid")
        }
        return values
            .iter()
            .map(|value| match value {
                Value::Null => Ok(None),
                Value::String(item_id) => {
                    ensure_item(state, item_id)?;
                    Ok(Some(item_id.clone()))
                }
                _ => bail!("native interstellar-station output item is invalid"),
            })
            .collect();
    }
    if !derive_from_station_slots {
        return Ok(vec![None; OUTPUT_PORTS]);
    }
    let mut result = Vec::with_capacity(OUTPUT_PORTS);
    let slots = match object.get("stationSlots") {
        None | Some(Value::Null) => &[][..],
        Some(Value::Array(values)) => values.as_slice(),
        _ => bail!("native interstellar-station slots are invalid"),
    };
    for slot in slots.iter().take(OUTPUT_PORTS) {
        let slot = slot
            .as_object()
            .ok_or_else(|| anyhow!("native interstellar-station slot is invalid"))?;
        match slot.get("itemId") {
            None | Some(Value::Null) => result.push(None),
            Some(Value::String(item_id)) => {
                ensure_item(state, item_id)?;
                result.push(Some(item_id.clone()));
            }
            _ => bail!("native interstellar-station slot item is invalid"),
        }
    }
    result.resize(OUTPUT_PORTS, None);
    Ok(result)
}

fn apply_construction_buffer(station: &mut Map<String, Value>) -> anyhow::Result<()> {
    let multiplier = strict_safe_u64(
        station.get("costMultiplierBasisPoints"),
        "station cost multiplier",
    )?;
    if !(8_000..=10_000).contains(&multiplier) {
        bail!("native system-space-station cost multiplier is invalid")
    }
    let mut phase_index =
        strict_safe_u64(station.get("phaseIndex"), "station phase index")? as usize;
    if phase_index > STATION_PHASES.len() {
        bail!("native system-space-station phase index is invalid")
    }
    let mut delivered = decimal_map(station.get("delivered"), "station delivered")?;
    let mut buffer = decimal_map(
        station.get("constructionBuffer"),
        "station construction buffer",
    )?;
    while phase_index < STATION_PHASES.len() {
        let phase_name = STATION_PHASES[phase_index].0;
        let phase_end = STATION_PHASES[phase_index..]
            .iter()
            .position(|(name, _, _)| *name != phase_name)
            .map(|offset| phase_index + offset)
            .unwrap_or(STATION_PHASES.len());
        let mut complete = true;
        for (_, item_id, base) in &STATION_PHASES[phase_index..phase_end] {
            let required = required_amount(*base, multiplier);
            let current = delivered
                .get(*item_id)
                .cloned()
                .unwrap_or_else(BigUint::zero);
            let remaining = required.saturating_sub(&current);
            let available = buffer.get(*item_id).cloned().unwrap_or_else(BigUint::zero);
            let take = available.min(remaining);
            if !take.is_zero() {
                add_decimal_exact(&mut delivered, item_id, &take)?;
                subtract_decimal_exact(&mut buffer, item_id, &take)?;
            }
            if delivered
                .get(*item_id)
                .cloned()
                .unwrap_or_else(BigUint::zero)
                < required
            {
                complete = false;
            }
        }
        if !complete {
            break;
        }
        phase_index = phase_end;
    }
    station.insert("delivered".to_owned(), decimal_map_value(&delivered));
    station.insert("constructionBuffer".to_owned(), decimal_map_value(&buffer));
    station.insert("phaseIndex".to_owned(), Value::from(phase_index));
    station.insert(
        "status".to_owned(),
        Value::String(
            if phase_index == STATION_PHASES.len() {
                "operational"
            } else {
                "building"
            }
            .to_owned(),
        ),
    );
    Ok(())
}

fn station_value(state: &CoreState, system_id: &str) -> anyhow::Result<Value> {
    state
        .base_value()
        .get("systemSpaceStations")
        .and_then(Value::as_object)
        .and_then(|stations| stations.get(system_id))
        .cloned()
        .ok_or_else(|| anyhow!("native system-space-station record is missing"))
}

fn station_value_or_default(state: &CoreState, system_id: &str) -> anyhow::Result<Value> {
    let stations = state
        .base_value()
        .get("systemSpaceStations")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native system-space-station directory is invalid"))?;
    Ok(stations.get(system_id).cloned().unwrap_or_else(|| {
        json!({
            "systemId": system_id,
            "status": "not-started",
            "costRevision": 0,
            "costMultiplierBasisPoints": 10000,
            "phaseIndex": 0,
            "delivered": {},
            "constructionBuffer": {},
            "inventory": {},
            "itemPolicies": {},
            "modules": {"backbone": 0, "energy": 0, "interstellar": 0},
            "routingCursors": {},
            "viewport": {"x": 0, "y": 0, "zoom": 0.85},
            "decorations": []
        })
    }))
}

fn validate_station_identity(
    station: &Map<String, Value>,
    expected_system_id: &str,
) -> anyhow::Result<()> {
    if string_field(station, "systemId")? != expected_system_id {
        bail!("native system-space-station record belongs to another system")
    }
    Ok(())
}

fn completed_techs(state: &CoreState) -> anyhow::Result<BTreeSet<&str>> {
    let values = state
        .base_value()
        .get("research")
        .and_then(Value::as_object)
        .and_then(|research| research.get("completedTechIds"))
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("native system-space-station research state is invalid"))?;
    values
        .iter()
        .map(|value| {
            value.as_str().ok_or_else(|| {
                anyhow!("native system-space-station completed technology is invalid")
            })
        })
        .collect()
}

fn ensure_system(state: &CoreState, system_id: &str) -> anyhow::Result<()> {
    if !state
        .catalog
        .planets
        .iter()
        .any(|planet| planet.system_id == system_id)
    {
        bail!("native system-space-station system is not in the built-in catalog")
    }
    Ok(())
}

fn planet_system<'a>(state: &'a CoreState, planet_id: &str) -> anyhow::Result<&'a str> {
    state
        .catalog
        .planets
        .iter()
        .find(|planet| planet.id == planet_id)
        .map(|planet| planet.system_id.as_str())
        .ok_or_else(|| anyhow!("native system-space-station planet is not in the built-in catalog"))
}

fn ensure_item(state: &CoreState, item_id: &str) -> anyhow::Result<()> {
    if !state.catalog.items.contains_key(item_id) {
        bail!("native system-space-station item is not in the built-in catalog")
    }
    Ok(())
}

fn optional_mode(value: Option<&Value>) -> anyhow::Result<&str> {
    match value {
        None | Some(Value::Null) => Ok("legacy"),
        Some(Value::String(value)) if value == "legacy" || value == "elevator" => Ok(value),
        _ => bail!("native interstellar-station operation mode is invalid"),
    }
}

fn string_field<'a>(object: &'a Map<String, Value>, key: &str) -> anyhow::Result<&'a str> {
    object
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("native system-space-station {key} is invalid"))
}

fn strict_safe_u64(value: Option<&Value>, label: &str) -> anyhow::Result<u64> {
    value
        .and_then(Value::as_u64)
        .filter(|value| *value <= MAX_SAFE_INTEGER)
        .ok_or_else(|| anyhow!("native {label} is not a nonnegative safe integer"))
}

fn optional_safe_u64(value: Option<&Value>, label: &str) -> anyhow::Result<u64> {
    match value {
        None => Ok(0),
        value => strict_safe_u64(value, label),
    }
}

fn valid_command_text(label: &str, value: &str) -> anyhow::Result<()> {
    if value.is_empty()
        || value.len() > MAX_COMMAND_TEXT_BYTES
        || value.chars().any(char::is_control)
    {
        bail!("native system-space-station {label} is invalid")
    }
    Ok(())
}

fn valid_domain_id(label: &str, value: &str) -> anyhow::Result<()> {
    valid_command_text(label, value)?;
    if !value.bytes().all(|byte| {
        byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b':' | b'/')
    }) {
        bail!("native system-space-station {label} is invalid")
    }
    Ok(())
}

fn required_amount(base: u64, multiplier: u64) -> BigUint {
    // All current products are integral, but retain the JS ceil rule.
    BigUint::from((base * multiplier).div_ceil(10_000))
}

fn decimal_map(value: Option<&Value>, label: &str) -> anyhow::Result<BTreeMap<String, BigUint>> {
    let object = value
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native {label} is invalid"))?;
    object
        .iter()
        .map(|(key, value)| {
            let raw = value
                .as_str()
                .ok_or_else(|| anyhow!("native {label} contains a non-decimal amount"))?;
            Ok((key.clone(), parse_decimal(raw, label)?))
        })
        .collect()
}

fn parse_decimal(value: &str, label: &str) -> anyhow::Result<BigUint> {
    if value.is_empty()
        || value.len() > MAX_HUB_DIGITS
        || !value.bytes().all(|byte| byte.is_ascii_digit())
    {
        bail!("native {label} contains an invalid decimal amount")
    }
    BigUint::parse_bytes(value.as_bytes(), 10)
        .ok_or_else(|| anyhow!("native {label} contains an invalid decimal amount"))
}

fn decimal_map_value(map: &BTreeMap<String, BigUint>) -> Value {
    Value::Object(
        map.iter()
            .map(|(key, value)| (key.clone(), Value::String(value.to_string())))
            .collect(),
    )
}

fn max_decimal() -> BigUint {
    BigUint::from(10u8).pow(MAX_HUB_DIGITS as u32) - BigUint::one()
}

fn add_decimal_exact(
    map: &mut BTreeMap<String, BigUint>,
    item_id: &str,
    amount: &BigUint,
) -> anyhow::Result<()> {
    let next = map.get(item_id).cloned().unwrap_or_else(BigUint::zero) + amount;
    if next > max_decimal() {
        bail!("native system-space-station decimal amount overflow")
    }
    map.insert(item_id.to_owned(), next);
    Ok(())
}

fn add_decimal_saturated(map: &mut BTreeMap<String, BigUint>, item_id: &str, amount: &BigUint) {
    let next = map.get(item_id).cloned().unwrap_or_else(BigUint::zero) + amount;
    map.insert(item_id.to_owned(), next.min(max_decimal()));
}

fn subtract_decimal_exact(
    map: &mut BTreeMap<String, BigUint>,
    item_id: &str,
    amount: &BigUint,
) -> anyhow::Result<()> {
    let current = map.get(item_id).cloned().unwrap_or_else(BigUint::zero);
    if current < *amount {
        bail!("native system-space-station decimal inventory is insufficient")
    }
    map.insert(item_id.to_owned(), current - amount);
    Ok(())
}

fn escalating_cost(base: BigUint, start: u64, amount: u64) -> BigUint {
    let maximum = max_decimal();
    let end = start + amount;
    let mut cursor = start;
    let mut total = BigUint::zero();
    while cursor < end {
        let tier = cursor / 10;
        let next = end.min((tier + 1) * 10);
        // Values beyond this tier already exceed the persisted 256-digit cap.
        if tier > 1_024 {
            return maximum;
        }
        total += &base * (BigUint::one() << tier as usize) * (next - cursor);
        if total >= maximum {
            return maximum;
        }
        cursor = next;
    }
    total
}

fn sha256_json(value: &impl Serialize) -> anyhow::Result<String> {
    let bytes = serde_json::to_vec(value).context("encode native system-space-station command")?;
    Ok(hex::encode(Sha256::digest(bytes)))
}

trait SaturatingSub {
    fn saturating_sub(&self, other: &Self) -> Self;
}

impl SaturatingSub for BigUint {
    fn saturating_sub(&self, other: &Self) -> Self {
        if self > other {
            self - other
        } else {
            BigUint::zero()
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::catalog::{CatalogSnapshot, RuntimeCatalog};
    use crate::state::CoreCheckpointIdentity;

    fn catalog() -> RuntimeCatalog {
        let item_ids = [
            "titanium_alloy",
            "frame_material",
            "small_carrier_rocket",
            "universe_matrix",
            "dyson_sphere_component",
            "titanium_glass",
            "quantum_chip",
            "antimatter_fuel_rod",
            "annihilation_constraint_sphere",
            "strange_matter",
            "plane_filter",
            "processor",
            "particle_broadband",
            "particle_container",
            "space_warper",
            "iron_ore",
            "copper_ore",
        ];
        let snapshot = CatalogSnapshot {
            protocol_version: 1,
            registry_fingerprint: EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT.to_owned(),
            planets: serde_json::from_value(json!([
                {"id":"home","name":"Home","systemId":"helios","kind":"terrestrial","orbitIndex":1,"simulationOrder":0,"orbitalYields":{}},
                {"id":"moon","name":"Moon","systemId":"helios","kind":"terrestrial","orbitIndex":2,"simulationOrder":1,"orbitalYields":{}},
                {"id":"far","name":"Far","systemId":"alpha","kind":"terrestrial","orbitIndex":1,"simulationOrder":2,"orbitalYields":{}}
            ])).unwrap(),
            items: item_ids
                .iter()
                .map(|id| crate::catalog::ItemDefinition {
                    id: (*id).to_owned(),
                    name: (*id).to_owned(),
                    kind: "solid".to_owned(),
                    fuel_energy_mj: 0.0,
                })
                .collect(),
            buildings: serde_json::from_value(json!([
                {"id":"space_station_construction_launcher","kind":"station","speed":1,"inputCapacity":64,"outputCapacity":64,"powerDemandKw":1},
                {"id":"interstellar_logistics_station","kind":"station","speed":1,"inputCapacity":64,"outputCapacity":64,"powerDemandKw":1},
                {"id":"storage_mk1","kind":"storage","speed":1,"inputCapacity":64,"outputCapacity":64,"powerDemandKw":0}
            ])).unwrap(),
            recipes: Vec::new(),
            constructions: serde_json::from_value(json!([
                {"id":"conveyor_belt_mk1","outputAmount":1,"costs":[{"itemId":"iron_ore","amount":1}]},
                {"id":"conveyor_belt_mk2","outputAmount":1,"costs":[{"itemId":"iron_ore","amount":1}]},
                {"id":"conveyor_belt_mk3","outputAmount":1,"costs":[{"itemId":"iron_ore","amount":1}]}
            ])).unwrap(),
            belts: serde_json::from_value(json!([
                {"tier":1,"speed":6}, {"tier":2,"speed":12}, {"tier":3,"speed":30}
            ])).unwrap(),
            proliferators: Vec::new(),
            technologies: Vec::new(),
        };
        RuntimeCatalog::validate(snapshot, EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT).unwrap()
    }

    fn station(system_id: &str, status: &str) -> Value {
        json!({
            "systemId": system_id,
            "status": status,
            "costRevision": 0,
            "costMultiplierBasisPoints": 10000,
            "phaseIndex": if status == "operational" { 16 } else { 0 },
            "delivered": {},
            "constructionBuffer": {},
            "inventory": {
                "frame_material":"1000000000",
                "quantum_chip":"1000000000",
                "processor":"1000000000",
                "universe_matrix":"1000000000",
                "antimatter_fuel_rod":"1000000000",
                "annihilation_constraint_sphere":"1000000000",
                "strange_matter":"1000000000",
                "titanium_alloy":"1000000000",
                "particle_container":"1000000000",
                "space_warper":"1000000000"
            },
            "itemPolicies": {},
            "modules": {"backbone":0,"energy":0,"interstellar":0},
            "routingCursors": {},
            "viewport": {"x":0,"y":0,"zoom":0.85},
            "decorations": []
        })
    }

    fn launcher(id: &str, planet_id: &str, power: f64) -> Value {
        json!({
            "id":id,"kind":"station","planetId":planet_id,
            "buildingId":"space_station_construction_launcher","machineCount":1,
            "inputs":{},"outputs":{},"powerFactor":power,"progress":0,
            "utilization":0,"productionRate":0,"routingCursor":0
        })
    }

    fn elevator(id: &str, planet_id: &str, tier: u64, mode: &str, power: f64) -> Value {
        json!({
            "id":id,"kind":"station","planetId":planet_id,
            "buildingId":"interstellar_logistics_station","machineCount":1,
            "stationTier":tier,"stationOperationMode":mode,"stationModeTransition":null,
            "stationSlots":[{"itemId":"iron_ore"},{"itemId":"copper_ore"}],
            "stationRoutes":[],"elevatorOutputItems":["iron_ore","copper_ore",null,null,null],
            "inputs":{},"outputs":{},"powerFactor":power,"progress":0,
            "utilization":0,"productionRate":0,"routingCursor":0
        })
    }

    fn storage(id: &str) -> Value {
        json!({
            "id":id,"kind":"storage","planetId":"home","buildingId":"storage_mk1",
            "machineCount":1,"inputs":{},"outputs":{},"powerFactor":1,
            "progress":0,"utilization":0,"productionRate":0,"routingCursor":0
        })
    }

    fn belt(id: &str, source: &str, item_id: &str, tier: u64, lanes: u64) -> Value {
        json!({
            "id":id,"planetId":"home","source":source,"target":"sink",
            "itemId":item_id,"lanes":lanes,"tier":tier,"sorterTier":1,
            "progress":0,"priority":1,"stackSize":1,"monitorEnabled":false,
            "routeMode":"auto","lastFlow":0
        })
    }

    fn base(techs: &[&str]) -> Map<String, Value> {
        json!({
            "version":47,"mode":"normal","activePlanetId":"home",
            "elapsedSeconds":0,"paused":false,
            "exploration":{"unlockedSystemIds":["helios","alpha"]},
            "research":{"completedTechIds":techs},
            "systemSpaceStations":{
                "helios":station("helios","not-started"),
                "alpha":station("alpha","operational")
            },
            "planetTrays":{"home":{"titanium_alloy":1500000},"moon":{},"far":{}},
            "tray":{"titanium_alloy":1500000},
            "construction":{"conveyor_belt_mk1":10,"conveyor_belt_mk2":20,"conveyor_belt_mk3":30},
            "galacticHubNetwork":{"fleetInstalled":0,"fleetBusy":0,"fleetReturns":[],"warpers":"0","warperTarget":"0","routingCursors":{}},
            "settings":{"logisticsBufferLimit":1000000}
        })
        .as_object()
        .unwrap()
        .clone()
    }

    fn state_with(techs: &[&str], entities: Vec<Value>, belts: Vec<Value>) -> CoreState {
        CoreState::from_public_v47_parts(
            CoreCheckpointIdentity {
                slot: "normal-main".to_owned(),
                generation: 1,
                root_hash: "a".repeat(64),
                revision: 7,
                state_version: 47,
                mode: "normal".to_owned(),
                registry_fingerprint: EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT.to_owned(),
                base_primary_checksum: "12345678".to_owned(),
            },
            base(techs),
            entities
                .into_iter()
                .map(|value| serde_json::to_string(&value).unwrap())
                .collect(),
            belts
                .into_iter()
                .map(|value| serde_json::to_string(&value).unwrap())
                .collect(),
            catalog(),
        )
        .unwrap()
    }

    fn authority() -> SystemSpaceStationAuthority {
        SystemSpaceStationAuthority {
            session_id: "session-1".to_owned(),
            run_id: "run-1".to_owned(),
        }
    }

    fn request(intent: SystemSpaceStationIntent) -> SystemSpaceStationCommandRequest {
        SystemSpaceStationCommandRequest {
            command_id: "command-1".to_owned(),
            session_id: "session-1".to_owned(),
            run_id: "run-1".to_owned(),
            expected_revision: 7,
            expected_registry_fingerprint: EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT.to_owned(),
            intent,
        }
    }

    fn station_after<'a>(state: &'a CoreState, system_id: &str) -> &'a Map<String, Value> {
        state
            .base_value()
            .get("systemSpaceStations")
            .unwrap()
            .get(system_id)
            .unwrap()
            .as_object()
            .unwrap()
    }

    #[test]
    fn start_is_two_phase_and_zero_power_does_not_block_manual_command() {
        let mut state = state_with(
            &[STATION_ENGINEERING, AUTONOMOUS_CONSTRUCTION],
            vec![launcher("launcher", "home", 0.0)],
            vec![],
        );
        let prepared = prepare_system_space_station_command(
            &state,
            &authority(),
            request(SystemSpaceStationIntent::Start {
                system_id: "helios".to_owned(),
            }),
        )
        .unwrap();
        let binding = prepared.idempotency_binding();
        assert_eq!(binding.command_id, "command-1");
        assert_eq!(binding.semantic_sha256.len(), 64);
        prepared.apply(&mut state, &authority()).unwrap();
        let station = station_after(&state, "helios");
        assert_eq!(station["status"], "building");
        assert_eq!(station["costRevision"], 1);
        assert_eq!(station["costMultiplierBasisPoints"], 8000);
        assert_eq!(state.revision, 8);
    }

    #[test]
    fn prepare_rejects_stale_session_run_revision_registry_and_apply_toctou() {
        let state = state_with(
            &[STATION_ENGINEERING],
            vec![launcher("launcher", "home", 1.0)],
            vec![],
        );
        for mutate in 0..4 {
            let mut candidate = request(SystemSpaceStationIntent::Start {
                system_id: "helios".to_owned(),
            });
            match mutate {
                0 => candidate.session_id = "other".to_owned(),
                1 => candidate.run_id = "other".to_owned(),
                2 => candidate.expected_revision = 6,
                _ => candidate.expected_registry_fingerprint = "modded".to_owned(),
            }
            assert!(prepare_system_space_station_command(&state, &authority(), candidate).is_err());
        }
        let prepared = prepare_system_space_station_command(
            &state,
            &authority(),
            request(SystemSpaceStationIntent::Start {
                system_id: "helios".to_owned(),
            }),
        )
        .unwrap();
        let mut changed = state.clone();
        let other = prepare_system_space_station_command(
            &changed,
            &authority(),
            request(SystemSpaceStationIntent::ModuleTarget {
                system_id: "alpha".to_owned(),
                module: SystemSpaceStationModule::Backbone,
                target: 1,
            }),
        )
        .unwrap();
        other.apply(&mut changed, &authority()).unwrap();
        assert!(prepared.apply(&mut changed, &authority()).is_err());
    }

    #[test]
    fn delivery_moves_exact_integer_once_and_completes_only_phase_order() {
        let mut state = state_with(&[], vec![launcher("launcher", "home", 0.0)], vec![]);
        station_after(&state, "helios");
        state
            .base_value_mut()
            .get_mut("systemSpaceStations")
            .unwrap()
            .get_mut("helios")
            .unwrap()
            .as_object_mut()
            .unwrap()
            .insert("status".to_owned(), Value::String("building".to_owned()));
        let before = state.canonical_sha256().unwrap();
        let prepared = prepare_system_space_station_command(
            &state,
            &authority(),
            request(SystemSpaceStationIntent::DeliverFromTray {
                system_id: "helios".to_owned(),
                planet_id: "home".to_owned(),
                item_id: "titanium_alloy".to_owned(),
                requested_amount: 1_200_000,
            }),
        )
        .unwrap();
        assert_eq!(state.canonical_sha256().unwrap(), before, "prepare is pure");
        prepared.apply(&mut state, &authority()).unwrap();
        let station = station_after(&state, "helios");
        assert_eq!(station["delivered"]["titanium_alloy"], "1000000");
        assert_eq!(station["constructionBuffer"]["titanium_alloy"], "0");
        assert_eq!(
            station["phaseIndex"], 0,
            "other rows keep phase zero incomplete"
        );
        assert_eq!(
            state.base_value()["planetTrays"]["home"]["titanium_alloy"],
            500000
        );
        assert_eq!(state.base_value()["tray"]["titanium_alloy"], 500000);
    }

    #[test]
    fn module_increase_decrease_conserves_inventory_and_rejects_insufficient_or_max() {
        let mut state = state_with(&[], vec![], vec![]);
        let prepared = prepare_system_space_station_command(
            &state,
            &authority(),
            request(SystemSpaceStationIntent::ModuleTarget {
                system_id: "alpha".to_owned(),
                module: SystemSpaceStationModule::Backbone,
                target: 2,
            }),
        )
        .unwrap();
        prepared.apply(&mut state, &authority()).unwrap();
        let station = station_after(&state, "alpha");
        assert_eq!(station["modules"]["backbone"], 2);
        assert_eq!(station["inventory"]["frame_material"], "999800000");

        let mut down = request(SystemSpaceStationIntent::ModuleTarget {
            system_id: "alpha".to_owned(),
            module: SystemSpaceStationModule::Backbone,
            target: 0,
        });
        down.expected_revision = 8;
        let prepared = prepare_system_space_station_command(&state, &authority(), down).unwrap();
        prepared.apply(&mut state, &authority()).unwrap();
        assert_eq!(
            station_after(&state, "alpha")["inventory"]["frame_material"],
            "999900000"
        );

        let mut poor = state_with(&[], vec![], vec![]);
        poor.base_value_mut()
            .get_mut("systemSpaceStations")
            .unwrap()
            .get_mut("alpha")
            .unwrap()["inventory"]["frame_material"] = json!("0");
        assert!(
            prepare_system_space_station_command(
                &poor,
                &authority(),
                request(SystemSpaceStationIntent::ModuleTarget {
                    system_id: "alpha".to_owned(),
                    module: SystemSpaceStationModule::Backbone,
                    target: 1
                })
            )
            .is_err()
        );
        assert!(
            prepare_system_space_station_command(
                &poor,
                &authority(),
                request(SystemSpaceStationIntent::ModuleTarget {
                    system_id: "alpha".to_owned(),
                    module: SystemSpaceStationModule::Backbone,
                    target: MAX_MODULE_COUNT + 1
                })
            )
            .is_err()
        );
    }

    #[test]
    fn upgrade_one_and_all_are_stable_free_access_changes_and_ignore_power() {
        let mut state = state_with(
            &[QUANTUM_LOGISTICS],
            vec![
                elevator("z-station", "home", 1, "legacy", 0.0),
                elevator("a-station", "far", 1, "legacy", 1.0),
            ],
            vec![belt("belt-z", "z-station", "iron_ore", 1, 1)],
        );
        let prepared = prepare_system_space_station_command(
            &state,
            &authority(),
            request(SystemSpaceStationIntent::UpgradeAll { system_id: None }),
        )
        .unwrap();
        assert_eq!(
            prepared
                .patch()
                .changed_entities
                .iter()
                .map(|row| row.id.as_str())
                .collect::<Vec<_>>(),
            vec!["a-station", "z-station"]
        );
        prepared.apply(&mut state, &authority()).unwrap();
        for id in ["a-station", "z-station"] {
            let index = *state.entity_index.get(id).unwrap();
            assert_eq!(state.parse_entity(index).unwrap()["stationTier"], 2);
        }
        let belt_index = *state.belt_index.get("belt-z").unwrap();
        assert_eq!(
            state.parse_belt(belt_index).unwrap()["elevatorOutputIndex"],
            0
        );

        let wrong = state_with(&[QUANTUM_LOGISTICS], vec![storage("box")], vec![]);
        assert!(
            prepare_system_space_station_command(
                &wrong,
                &authority(),
                request(SystemSpaceStationIntent::UpgradeOne {
                    entity_id: "box".to_owned()
                })
            )
            .is_err()
        );
    }

    #[test]
    fn mode_and_output_commands_assign_ports_remove_belts_and_refund_exact_lanes() {
        let mut state = state_with(
            &[MULTI_CARGO_BUS],
            vec![elevator("station", "home", 2, "legacy", 0.0)],
            vec![belt("belt-a", "station", "iron_ore", 2, 3)],
        );
        let mode = prepare_system_space_station_command(
            &state,
            &authority(),
            request(SystemSpaceStationIntent::ModeTarget {
                entity_id: "station".to_owned(),
                mode: InterstellarStationMode::Elevator,
            }),
        )
        .unwrap();
        mode.apply(&mut state, &authority()).unwrap();
        let entity_index = *state.entity_index.get("station").unwrap();
        assert_eq!(
            state.parse_entity(entity_index).unwrap()["stationModeTransition"],
            "to-elevator"
        );
        let belt_index = *state.belt_index.get("belt-a").unwrap();
        assert_eq!(
            state.parse_belt(belt_index).unwrap()["elevatorOutputIndex"],
            0
        );

        // Runtime settlement owns transition completion. Emulate its proven
        // result before issuing the player output command.
        let mut entity = state.parse_entity(entity_index).unwrap();
        entity["stationOperationMode"] = json!("elevator");
        entity["stationModeTransition"] = Value::Null;
        let mut transition = empty_patch(&state);
        transition
            .changed_entities
            .push(replace_record("station", entity));
        state.apply_command(&transition).unwrap();

        let mut output_request = request(SystemSpaceStationIntent::OutputTarget {
            entity_id: "station".to_owned(),
            port_index: 0,
            item_id: Some("copper_ore".to_owned()),
            confirmations: 2,
        });
        output_request.expected_revision = 9;
        assert!(
            prepare_system_space_station_command(&state, &authority(), output_request.clone())
                .is_err(),
            "duplicate item is rejected"
        );
        output_request.intent = SystemSpaceStationIntent::OutputTarget {
            entity_id: "station".to_owned(),
            port_index: 0,
            item_id: None,
            confirmations: 2,
        };
        let output =
            prepare_system_space_station_command(&state, &authority(), output_request).unwrap();
        output.apply(&mut state, &authority()).unwrap();
        assert!(state.belt_index.get("belt-a").is_none());
        assert_eq!(state.base_value()["construction"]["conveyor_belt_mk2"], 23);
    }

    #[test]
    fn mode_target_does_not_invent_outputs_from_legacy_station_slots() {
        let mut legacy = elevator("station", "home", 2, "legacy", 1.0);
        legacy
            .as_object_mut()
            .unwrap()
            .remove("elevatorOutputItems");
        let state = state_with(
            &[MULTI_CARGO_BUS],
            vec![legacy],
            vec![belt("belt-a", "station", "iron_ore", 1, 1)],
        );
        let prepared = prepare_system_space_station_command(
            &state,
            &authority(),
            request(SystemSpaceStationIntent::ModeTarget {
                entity_id: "station".to_owned(),
                mode: InterstellarStationMode::Elevator,
            }),
        )
        .unwrap();
        assert!(
            prepared.patch().changed_belts.is_empty(),
            "mode target uses five empty outputs; only upgrade derives from legacy slots"
        );
    }

    #[test]
    fn command_id_binding_is_replay_stable_and_detects_payload_collision() {
        let state = state_with(&[], vec![], vec![]);
        let first_request = request(SystemSpaceStationIntent::ModuleTarget {
            system_id: "alpha".to_owned(),
            module: SystemSpaceStationModule::Backbone,
            target: 1,
        });
        let first =
            prepare_system_space_station_command(&state, &authority(), first_request.clone())
                .unwrap();
        let replay =
            prepare_system_space_station_command(&state, &authority(), first_request).unwrap();
        assert_eq!(first.idempotency_binding(), replay.idempotency_binding());
        assert_eq!(
            classify_system_space_station_idempotency(
                Some(&first.idempotency_binding()),
                &replay.idempotency_binding(),
            )
            .unwrap(),
            SystemSpaceStationIdempotencyDecision::ReplayRecordedResult
        );
        let collision = prepare_system_space_station_command(
            &state,
            &authority(),
            request(SystemSpaceStationIntent::ModuleTarget {
                system_id: "alpha".to_owned(),
                module: SystemSpaceStationModule::Backbone,
                target: 2,
            }),
        )
        .unwrap();
        assert_eq!(
            first.idempotency_binding().command_id,
            collision.idempotency_binding().command_id
        );
        assert_ne!(
            first.idempotency_binding().semantic_sha256,
            collision.idempotency_binding().semantic_sha256
        );
        assert!(
            classify_system_space_station_idempotency(
                Some(&first.idempotency_binding()),
                &collision.idempotency_binding(),
            )
            .is_err()
        );
    }

    #[test]
    fn maxed_and_inapplicable_targets_fail_closed_without_mutation() {
        let state = state_with(
            &[QUANTUM_LOGISTICS],
            vec![elevator("maxed", "home", 2, "legacy", 0.0)],
            vec![],
        );
        let before = state.canonical_sha256().unwrap();
        assert!(
            prepare_system_space_station_command(
                &state,
                &authority(),
                request(SystemSpaceStationIntent::UpgradeOne {
                    entity_id: "maxed".to_owned(),
                }),
            )
            .is_err()
        );
        assert!(
            prepare_system_space_station_command(
                &state,
                &authority(),
                request(SystemSpaceStationIntent::OutputTarget {
                    entity_id: "maxed".to_owned(),
                    port_index: 0,
                    item_id: None,
                    confirmations: 2,
                }),
            )
            .is_err(),
            "legacy mode cannot edit elevator outputs"
        );
        assert!(
            prepare_system_space_station_command(
                &state,
                &authority(),
                request(SystemSpaceStationIntent::ModeTarget {
                    entity_id: "maxed".to_owned(),
                    mode: InterstellarStationMode::Elevator,
                }),
            )
            .is_err(),
            "elevator mode still requires its technology"
        );
        assert_eq!(state.canonical_sha256().unwrap(), before);
    }
}
