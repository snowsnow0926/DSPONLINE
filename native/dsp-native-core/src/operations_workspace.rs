//! Bounded Operations read model and seven semantic settings intents.
//!
//! The renderer never supplies a GameState patch. Rust binds every read and
//! write to the active authority lineage and expands an accepted intent into
//! one exact settings-leaf patch for the Host durable transaction.

use std::collections::{BTreeMap, BTreeSet};
use std::mem::size_of;
use std::sync::{Mutex, MutexGuard};

use anyhow::{anyhow, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::command::{
    EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT, PathSegment, SimulationCommandPatch, ValuePatch,
};
use crate::deterministic_runtime::{DeterministicRuntime, runtime as deterministic_runtime};
use crate::{CORE_PROTOCOL_VERSION, CommandApplyResult, CoreState};

pub const OPERATIONS_WORKSPACE_PROJECTION: &str = "operations-workspace-v1";
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_TEXT_BYTES: usize = 512;
const MAX_ALERT_ROWS: usize = 1_024;
const MAX_PROJECTION_BYTES: usize = 512 * 1_024;
const INCREMENTAL_DENSE_NUMERATOR: usize = 3;
const INCREMENTAL_DENSE_DENOMINATOR: usize = 4;

#[cfg(test)]
std::thread_local! {
    static ALERT_DEPENDENCY_WALKS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

type DysonOrbitIdentity = (Option<String>, Option<String>);
type DysonOrbitDirectory = BTreeMap<String, Vec<DysonOrbitIdentity>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
enum AlertClass {
    Quiet = 0,
    Critical = 1,
    Warning = 2,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AlertRow {
    entity_id: String,
    planet_id: String,
    building_id: Option<String>,
    recipe_id: Option<String>,
    resource_id: Option<String>,
    severity: &'static str,
    code: String,
    label: String,
}

impl AlertRow {
    fn to_value(&self) -> Value {
        json!({
            "entityId": self.entity_id,
            "planetId": self.planet_id,
            "buildingId": self.building_id,
            "recipeId": self.recipe_id,
            "resourceId": self.resource_id,
            "severity": self.severity,
            "code": self.code,
            "label": self.label,
        })
    }

    fn estimated_bytes(&self) -> usize {
        size_of::<Self>()
            .saturating_add(self.entity_id.capacity())
            .saturating_add(self.planet_id.capacity())
            .saturating_add(self.building_id.as_ref().map(String::capacity).unwrap_or(0))
            .saturating_add(self.recipe_id.as_ref().map(String::capacity).unwrap_or(0))
            .saturating_add(self.resource_id.as_ref().map(String::capacity).unwrap_or(0))
            .saturating_add(self.code.capacity())
            .saturating_add(self.label.capacity())
    }
}

#[derive(Debug, Clone)]
struct OperationsAlertCache {
    lineage_sha256: String,
    revision: u64,
    dependency_sha256: String,
    classes: Vec<AlertClass>,
    rows: BTreeMap<usize, AlertRow>,
    total_count: usize,
    critical_count: usize,
    warning_count: usize,
}

impl OperationsAlertCache {
    fn overflowed(&self) -> bool {
        self.total_count > MAX_ALERT_ROWS
    }

    fn snapshot(&self) -> OperationsAlertSnapshot {
        OperationsAlertSnapshot {
            overflow: self.overflowed(),
            total_count: self.total_count,
            critical_count: self.critical_count,
            warning_count: self.warning_count,
            rows: if self.overflowed() {
                Vec::new()
            } else {
                self.rows.values().map(AlertRow::to_value).collect()
            },
        }
    }

    fn estimated_bytes(&self) -> u64 {
        let row_bytes = self
            .rows
            .values()
            .map(AlertRow::estimated_bytes)
            .sum::<usize>();
        // Count three pointers plus the key/value payload for each BTree node.
        // This deliberately overestimates implementation-specific node slack.
        let tree_overhead = self.rows.len().saturating_mul(
            size_of::<usize>()
                .saturating_mul(4)
                .saturating_add(size_of::<AlertRow>()),
        );
        u64::try_from(
            size_of::<Self>()
                .saturating_add(self.lineage_sha256.capacity())
                .saturating_add(self.dependency_sha256.capacity())
                .saturating_add(self.classes.capacity() * size_of::<AlertClass>())
                .saturating_add(row_bytes)
                .saturating_add(tree_overhead),
        )
        .unwrap_or(u64::MAX)
    }

    fn structurally_consistent(&self) -> bool {
        if self.critical_count.saturating_add(self.warning_count) != self.total_count {
            return false;
        }
        let overflow = self.overflowed();
        let fast = if overflow {
            self.rows.is_empty()
        } else {
            self.rows.len() == self.total_count
                && self.rows.iter().all(|(index, row)| {
                    self.classes.get(*index).is_some_and(|class| match class {
                        AlertClass::Quiet => false,
                        AlertClass::Critical => row.severity == "critical",
                        AlertClass::Warning => row.severity == "warning",
                    })
                })
        };
        if !fast {
            return false;
        }
        // Debug/test builds independently re-prove the induction over the
        // complete class vector. Release builds retain the module-sealed
        // prepare token and O(changed)+O(max 1024 rows) install cost.
        #[cfg(debug_assertions)]
        {
            let mut total = 0usize;
            let mut critical = 0usize;
            let mut warning = 0usize;
            for (index, class) in self.classes.iter().enumerate() {
                match class {
                    AlertClass::Quiet => {
                        if !overflow && self.rows.contains_key(&index) {
                            return false;
                        }
                    }
                    AlertClass::Critical => {
                        total += 1;
                        critical += 1;
                        if !overflow
                            && self.rows.get(&index).map(|row| row.severity) != Some("critical")
                        {
                            return false;
                        }
                    }
                    AlertClass::Warning => {
                        total += 1;
                        warning += 1;
                        if !overflow
                            && self.rows.get(&index).map(|row| row.severity) != Some("warning")
                        {
                            return false;
                        }
                    }
                }
            }
            if (total, critical, warning)
                != (self.total_count, self.critical_count, self.warning_count)
            {
                return false;
            }
        }
        true
    }
}

#[derive(Debug)]
struct OperationsAlertSnapshot {
    overflow: bool,
    total_count: usize,
    critical_count: usize,
    warning_count: usize,
    rows: Vec<Value>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct OperationsProjectionDiagnostics {
    pub mode: &'static str,
    pub entity_rows_visited: usize,
    pub belt_rows_visited: usize,
    pub selected_worker_count: usize,
}

#[derive(Debug, Default)]
struct OperationsProjectionRuntimeState {
    cache: Option<OperationsAlertCache>,
    diagnostics: OperationsProjectionDiagnostics,
}

/// Session-only Operations projection cache. It is intentionally hash-neutral
/// and checkpoint-neutral. Transactional `CoreState` clones start empty: a
/// failed candidate can therefore lose only disposable work, never publish a
/// stale alert row into the source session.
#[derive(Debug, Default)]
pub(crate) struct OperationsProjectionRuntime(Mutex<OperationsProjectionRuntimeState>);

impl Clone for OperationsProjectionRuntime {
    fn clone(&self) -> Self {
        Self::default()
    }
}

#[derive(Debug)]
struct PreparedAlertChange {
    index: usize,
    class: AlertClass,
    row: Option<AlertRow>,
}

#[derive(Debug)]
enum PreparedOperationsProjectionUpdateInner {
    Reset {
        entity_rows_visited: usize,
    },
    Incremental {
        expected_revision: u64,
        revision: u64,
        lineage_sha256: String,
        dependency_sha256: String,
        changes: Vec<PreparedAlertChange>,
        total_count: usize,
        critical_count: usize,
        warning_count: usize,
        entity_rows_visited: usize,
        rebuilt_rows: Option<BTreeMap<usize, AlertRow>>,
    },
}

/// Opaque, module-sealed transaction token. Other core domains can carry the
/// prepared Operations update to the commit boundary, but cannot forge class
/// counts, rows, revisions or lineage seals.
#[derive(Debug)]
pub(crate) struct PreparedOperationsProjectionUpdate(PreparedOperationsProjectionUpdateInner);

impl PreparedOperationsProjectionUpdate {
    /// A projection update is a disposable session-only optimization.  If its
    /// preparation cannot prove an exact transition, the authoritative commit
    /// must still be allowed to publish and the read model is rebuilt lazily.
    pub(crate) fn reset_after_prepare_error() -> Self {
        Self(PreparedOperationsProjectionUpdateInner::Reset {
            entity_rows_visited: 0,
        })
    }
}

#[cfg(test)]
impl PreparedOperationsProjectionUpdate {
    fn is_reset(&self) -> bool {
        matches!(
            self.0,
            PreparedOperationsProjectionUpdateInner::Reset { .. }
        )
    }

    fn temporary_alert_row_count(&self) -> usize {
        match &self.0 {
            PreparedOperationsProjectionUpdateInner::Reset { .. } => 0,
            PreparedOperationsProjectionUpdateInner::Incremental {
                changes,
                rebuilt_rows,
                ..
            } => {
                changes.iter().filter(|change| change.row.is_some()).count()
                    + rebuilt_rows.as_ref().map(BTreeMap::len).unwrap_or(0)
            }
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AlertDependencies {
    paused: bool,
    production_buffer_limit: Option<u64>,
    logistics_buffer_limit: Option<u64>,
    resource_infinite: bool,
    simulation_speed: Option<u64>,
    power_grid_factors: BTreeMap<String, BTreeMap<String, Option<u64>>>,
    planet_power_factors: BTreeMap<String, Option<u64>>,
    vein_utilization_level: u16,
    ocean_types: BTreeMap<String, String>,
    dyson_launch_disabled: bool,
    dyson_orbits: DysonOrbitDirectory,
    construction_enabled: bool,
    construction_job_ids: BTreeSet<String>,
    time_warp_controller: Option<String>,
    time_warp_enabled: bool,
    time_warp_effective_multiplier: u64,
    selected_tech_present: bool,
    completed_tech_ids: BTreeSet<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OperationsLineage<'a> {
    slot: &'a str,
    generation: u64,
    root_hash: &'a str,
    checkpoint_revision: u64,
    state_version: u16,
    mode: &'a str,
    registry_fingerprint: &'a str,
    catalog_sha256: &'a str,
    base_primary_checksum: &'a str,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationsSettingAuthority {
    pub session_id: String,
    pub run_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum OperationsSettingIntent {
    SetSimulationSpeed { value: u64 },
    SetTechnologyLayout { value: String },
    SetDefaultBeltRouteMode { value: String },
    SetProductionBufferLimit { value: u64 },
    SetLogisticsBufferLimit { value: u64 },
    SetBeltBufferLimit { value: u64 },
    SetProliferatorBufferLimit { value: u64 },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationsSettingCommandRequest {
    pub command_id: String,
    pub session_id: String,
    pub run_id: String,
    pub expected_revision: u64,
    pub expected_registry_fingerprint: String,
    pub intent: OperationsSettingIntent,
}

#[derive(Debug, Clone)]
pub struct PreparedOperationsSettingCommand {
    request: OperationsSettingCommandRequest,
    base_sha256: String,
    semantic_sha256: String,
    patch_sha256: String,
    patch: SimulationCommandPatch,
}

impl PreparedOperationsSettingCommand {
    pub fn patch(&self) -> &SimulationCommandPatch {
        &self.patch
    }
    pub fn command_id(&self) -> &str {
        &self.request.command_id
    }
    pub fn expected_revision(&self) -> u64 {
        self.request.expected_revision
    }

    pub fn apply(
        &self,
        state: &mut CoreState,
        authority: &OperationsSettingAuthority,
    ) -> anyhow::Result<CommandApplyResult> {
        let current = prepare_operations_setting_command(state, authority, self.request.clone())?;
        if current.base_sha256 != self.base_sha256
            || current.semantic_sha256 != self.semantic_sha256
            || current.patch_sha256 != self.patch_sha256
        {
            bail!("native operations setting command changed after prepare")
        }
        let receipt = state.apply_command(&self.patch)?;
        if !receipt.changed_entity_ids.is_empty()
            || !receipt.changed_belt_ids.is_empty()
            || receipt.topology_dirty
        {
            bail!("native operations setting command changed factory topology")
        }
        Ok(receipt)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SemanticRequest<'a> {
    session_id: &'a str,
    run_id: &'a str,
    expected_revision: u64,
    expected_registry_fingerprint: &'a str,
    intent: &'a OperationsSettingIntent,
}

pub fn operations_setting_semantic_sha256(
    request: &OperationsSettingCommandRequest,
) -> anyhow::Result<String> {
    validate_text("command ID", &request.command_id)?;
    validate_text("session ID", &request.session_id)?;
    validate_text("run ID", &request.run_id)?;
    validate_text(
        "registry fingerprint",
        &request.expected_registry_fingerprint,
    )?;
    if request.expected_revision >= MAX_SAFE_INTEGER {
        bail!("native operations setting command revision is exhausted")
    }
    validate_intent(&request.intent)?;
    sha256_json(&SemanticRequest {
        session_id: &request.session_id,
        run_id: &request.run_id,
        expected_revision: request.expected_revision,
        expected_registry_fingerprint: &request.expected_registry_fingerprint,
        intent: &request.intent,
    })
}

pub fn derive_operations_setting_command_id(
    request: &OperationsSettingCommandRequest,
) -> anyhow::Result<String> {
    Ok(format!(
        "operations-setting-v1-{}",
        operations_setting_semantic_sha256(request)?
    ))
}

pub fn prepare_operations_setting_command(
    state: &CoreState,
    authority: &OperationsSettingAuthority,
    request: OperationsSettingCommandRequest,
) -> anyhow::Result<PreparedOperationsSettingCommand> {
    validate_text("current session ID", &authority.session_id)?;
    validate_text("current run ID", &authority.run_id)?;
    if request.session_id != authority.session_id {
        bail!("native operations setting command session is stale")
    }
    if request.run_id != authority.run_id {
        bail!("native operations setting command run is stale")
    }
    if request.expected_revision != state.revision || request.expected_revision >= MAX_SAFE_INTEGER
    {
        bail!("native operations setting command revision is stale")
    }
    require_operations_domain(state, &request.expected_registry_fingerprint)?;
    let semantic_sha256 = operations_setting_semantic_sha256(&request)?;
    let patch = build_patch(state, &request.intent)?;
    // Clone preflight proves this is one field only: no row clear, refund,
    // replacement, or topology/index rebuild can be hidden by a buffer intent.
    let mut candidate = state.clone();
    let receipt = candidate.apply_command(&patch)?;
    if !receipt.changed_entity_ids.is_empty()
        || !receipt.changed_belt_ids.is_empty()
        || receipt.topology_dirty
        || candidate.entities.ids.len() != state.entities.ids.len()
        || candidate.belts.ids.len() != state.belts.ids.len()
    {
        bail!("native operations setting command cannot prove leaf-only mutation")
    }
    let (field, target) = intent_target(&request.intent);
    if candidate
        .base_value()
        .get("settings")
        .and_then(Value::as_object)
        .and_then(|settings| settings.get(field))
        != Some(&target)
    {
        bail!("native operations setting command failed its leaf proof")
    }
    let patch_sha256 = sha256_json(&patch)?;
    Ok(PreparedOperationsSettingCommand {
        request,
        base_sha256: state.canonical_sha256()?,
        semantic_sha256,
        patch_sha256,
        patch,
    })
}

fn normalized_factor(value: Option<&Value>) -> Option<u64> {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .map(|value| value.clamp(0.0, 1.0).to_bits())
}

fn operations_lineage_sha256(state: &CoreState) -> anyhow::Result<String> {
    sha256_json(&OperationsLineage {
        slot: &state.identity.slot,
        generation: state.identity.generation,
        root_hash: &state.identity.root_hash,
        checkpoint_revision: state.identity.revision,
        state_version: state.identity.state_version,
        mode: &state.identity.mode,
        registry_fingerprint: &state.identity.registry_fingerprint,
        catalog_sha256: &state.catalog.fingerprint,
        base_primary_checksum: &state.identity.base_primary_checksum,
    })
}

fn alert_dependency_sha256(base: &Map<String, Value>) -> anyhow::Result<String> {
    #[cfg(test)]
    ALERT_DEPENDENCY_WALKS.with(|count| count.set(count.get().saturating_add(1)));
    let settings = base.get("settings").and_then(Value::as_object);
    let endgame = base.get("endgame").and_then(Value::as_object);
    let infinite_research = endgame
        .and_then(|value| value.get("infiniteResearch"))
        .and_then(Value::as_object);
    let galaxy = base.get("galaxy").and_then(Value::as_object);
    let dyson = base.get("dysonEngineering").and_then(Value::as_object);
    let construction = base
        .get("constructionAutomation")
        .and_then(Value::as_object);
    let time_warp = base.get("timeWarp").and_then(Value::as_object);
    let research = base.get("research").and_then(Value::as_object);
    let power_grid_factors = base
        .get("powerGridMetrics")
        .and_then(Value::as_object)
        .map(|planets| {
            planets
                .iter()
                .map(|(planet_id, grids)| {
                    let grids = grids
                        .as_object()
                        .map(|grids| {
                            grids
                                .iter()
                                .map(|(grid_id, grid)| {
                                    (grid_id.clone(), normalized_factor(grid.get("powerFactor")))
                                })
                                .collect::<BTreeMap<_, _>>()
                        })
                        .unwrap_or_default();
                    (planet_id.clone(), grids)
                })
                .collect::<BTreeMap<_, _>>()
        })
        .unwrap_or_default();
    let planet_power_factors = base
        .get("planetMetrics")
        .and_then(Value::as_object)
        .map(|planets| {
            planets
                .iter()
                .map(|(planet_id, metrics)| {
                    (
                        planet_id.clone(),
                        normalized_factor(metrics.get("powerFactor")),
                    )
                })
                .collect::<BTreeMap<_, _>>()
        })
        .unwrap_or_default();
    let vein_utilization_level = infinite_research
        .and_then(|value| value.get("vein_utilization"))
        .and_then(|value| value.get("level"))
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value >= 0.0)
        .unwrap_or(0.0)
        .floor()
        .min(1_000.0) as u16;
    let ocean_types = galaxy
        .and_then(|value| value.get("profiles"))
        .and_then(Value::as_object)
        .map(|profiles| {
            profiles
                .iter()
                .map(|(planet_id, profile)| {
                    (
                        planet_id.clone(),
                        profile
                            .get("oceanType")
                            .and_then(Value::as_str)
                            .unwrap_or("none")
                            .to_owned(),
                    )
                })
                .collect::<BTreeMap<_, _>>()
        })
        .unwrap_or_default();
    let dyson_orbits = dyson
        .and_then(|value| value.get("orbitsBySystem"))
        .and_then(Value::as_object)
        .map(|systems| {
            systems
                .iter()
                .map(|(system_id, orbits)| {
                    let rows = orbits
                        .as_array()
                        .map(|orbits| {
                            orbits
                                .iter()
                                .map(|orbit| {
                                    (
                                        orbit.get("id").and_then(Value::as_str).map(str::to_owned),
                                        orbit
                                            .get("name")
                                            .and_then(Value::as_str)
                                            .map(str::to_owned),
                                    )
                                })
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    (system_id.clone(), rows)
                })
                .collect::<BTreeMap<_, _>>()
        })
        .unwrap_or_default();
    let construction_job_ids = construction
        .and_then(|value| value.get("jobs"))
        .and_then(Value::as_object)
        .map(|jobs| {
            jobs.iter()
                .filter(|(_, job)| !job.is_null())
                .map(|(id, _)| id.clone())
                .collect::<BTreeSet<_>>()
        })
        .unwrap_or_default();
    let completed_tech_ids = research
        .and_then(|value| value.get("completedTechIds"))
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<BTreeSet<_>>()
        })
        .unwrap_or_default();
    let time_warp_effective_multiplier = time_warp
        .and_then(|value| value.get("effectiveMultiplier"))
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value >= 0.0)
        .unwrap_or(0.0)
        .to_bits();
    sha256_json(&AlertDependencies {
        paused: base.get("paused").and_then(Value::as_bool).unwrap_or(false),
        production_buffer_limit: settings
            .and_then(|value| value.get("productionBufferLimit"))
            .and_then(Value::as_u64),
        logistics_buffer_limit: settings
            .and_then(|value| value.get("logisticsBufferLimit"))
            .and_then(Value::as_u64),
        resource_infinite: settings
            .and_then(|value| value.get("resourceMode"))
            .and_then(Value::as_str)
            == Some("infinite"),
        simulation_speed: settings
            .and_then(|value| value.get("simulationSpeed"))
            .and_then(Value::as_u64),
        power_grid_factors,
        planet_power_factors,
        vein_utilization_level,
        ocean_types,
        dyson_launch_disabled: dyson
            .and_then(|value| value.get("launchEnabled"))
            .and_then(Value::as_bool)
            == Some(false),
        dyson_orbits,
        construction_enabled: construction
            .and_then(|value| value.get("enabled"))
            .and_then(Value::as_bool)
            == Some(true),
        construction_job_ids,
        time_warp_controller: time_warp
            .and_then(|value| value.get("controllerEntityId"))
            .and_then(Value::as_str)
            .map(str::to_owned),
        time_warp_enabled: time_warp
            .and_then(|value| value.get("enabled"))
            .and_then(Value::as_bool)
            == Some(true),
        time_warp_effective_multiplier,
        selected_tech_present: research
            .and_then(|value| value.get("selectedTechId"))
            .is_some_and(|value| !value.is_null()),
        completed_tech_ids,
    })
}

fn optional_text_ref<'a>(value: Option<&'a Value>, label: &str) -> anyhow::Result<Option<&'a str>> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => {
            validate_text(label, value)?;
            Ok(Some(value))
        }
        _ => bail!("native operations {label} is invalid"),
    }
}

fn evaluate_alert_entity(
    state: &CoreState,
    base: &Map<String, Value>,
    entity: &Value,
    include_row: bool,
) -> anyhow::Result<(AlertClass, Option<AlertRow>)> {
    let object = entity
        .as_object()
        .ok_or_else(|| anyhow!("native operations entity is invalid"))?;
    let entity_id = required_text(object.get("id"), "entity ID")?;
    let planet_id = required_text(object.get("planetId"), "entity planet ID")?;
    if !state
        .catalog
        .planets
        .iter()
        .any(|planet| planet.id == planet_id)
    {
        bail!("native operations entity planet is outside the catalog")
    }
    let presentation = crate::factory_canvas_presentation::project_entity(
        &state.identity.registry_fingerprint,
        &state.catalog,
        base,
        entity,
    );
    let (class, severity, code, label) =
        if presentation.get("supported").and_then(Value::as_bool) != Some(true) {
            (
                AlertClass::Critical,
                "critical",
                "unsupported-state",
                "状态无法证明，已按严重告警处理",
            )
        } else {
            let status = presentation
                .get("status")
                .and_then(Value::as_object)
                .ok_or_else(|| anyhow!("native operations entity status is invalid"))?;
            match status.get("tone").and_then(Value::as_str) {
                Some("blocked") => (
                    AlertClass::Critical,
                    "critical",
                    required_text(status.get("code"), "alert code")?,
                    required_text(status.get("label"), "alert label")?,
                ),
                Some("warning") => (
                    AlertClass::Warning,
                    "warning",
                    required_text(status.get("code"), "alert code")?,
                    required_text(status.get("label"), "alert label")?,
                ),
                Some("running" | "idle") => return Ok((AlertClass::Quiet, None)),
                Some(_) => (
                    AlertClass::Critical,
                    "critical",
                    "unsupported-state",
                    "状态无法证明，已按严重告警处理",
                ),
                None => bail!("native operations entity status tone is invalid"),
            }
        };
    // Alert rows historically validate their optional identity fields before
    // publication. Keep that fail-closed contract even when an overflow means
    // the bounded response will omit every row; malformed data must never be
    // hidden merely by creating a 1,025th alert.
    let building_id = optional_text_ref(object.get("buildingId"), "building ID")?;
    let recipe_id = optional_text_ref(object.get("recipeId"), "recipe ID")?;
    let resource_id = optional_text_ref(object.get("resourceId"), "resource ID")?;
    if !include_row {
        return Ok((class, None));
    }
    Ok((
        class,
        Some(AlertRow {
            entity_id: entity_id.to_owned(),
            planet_id: planet_id.to_owned(),
            building_id: building_id.map(str::to_owned),
            recipe_id: recipe_id.map(str::to_owned),
            resource_id: resource_id.map(str::to_owned),
            severity,
            code: code.to_owned(),
            label: label.to_owned(),
        }),
    ))
}

fn validate_belt_planets_with_runtime(
    state: &CoreState,
    runtime: &DeterministicRuntime,
) -> anyhow::Result<()> {
    runtime.indexed_try_map_range(
        0..state.belts.ids.len(),
        |index| {
            let belt = state.parse_belt(index)?;
            let planet_id = required_text(belt.get("planetId"), "belt planet ID")?;
            if !state
                .catalog
                .planets
                .iter()
                .any(|planet| planet.id == planet_id)
            {
                bail!("native operations belt planet is outside the catalog")
            }
            Ok(())
        },
        |_| (),
    )?;
    Ok(())
}

fn build_alert_cache_with_runtime(
    state: &CoreState,
    base: &Map<String, Value>,
    dependency_sha256: String,
    runtime: &DeterministicRuntime,
) -> anyhow::Result<OperationsAlertCache> {
    let lineage_sha256 = operations_lineage_sha256(state)?;
    let classes = runtime.indexed_try_map_range(
        0..state.entities.ids.len(),
        |index| {
            let entity = state.parse_entity(index)?;
            evaluate_alert_entity(state, base, &entity, false).map(|(class, _)| class)
        },
        |_| AlertClass::Quiet,
    )?;
    // Preserve the established fail-closed error order: entity records are
    // validated before belt records when both domains are malformed.
    validate_belt_planets_with_runtime(state, runtime)?;
    let mut total_count = 0usize;
    let mut critical_count = 0usize;
    let mut warning_count = 0usize;
    for class in &classes {
        match class {
            AlertClass::Quiet => {}
            AlertClass::Critical => {
                total_count = total_count
                    .checked_add(1)
                    .ok_or_else(|| anyhow!("native operations alert count overflow"))?;
                critical_count = critical_count
                    .checked_add(1)
                    .ok_or_else(|| anyhow!("native operations critical alert count overflow"))?;
            }
            AlertClass::Warning => {
                total_count = total_count
                    .checked_add(1)
                    .ok_or_else(|| anyhow!("native operations alert count overflow"))?;
                warning_count = warning_count
                    .checked_add(1)
                    .ok_or_else(|| anyhow!("native operations warning alert count overflow"))?;
            }
        }
    }
    let mut rows = BTreeMap::new();
    if total_count <= MAX_ALERT_ROWS {
        for (index, class) in classes.iter().copied().enumerate() {
            if class == AlertClass::Quiet {
                continue;
            }
            let entity = state.parse_entity(index)?;
            let (confirmed_class, row) = evaluate_alert_entity(state, base, &entity, true)?;
            if confirmed_class != class {
                bail!("native operations alert classification changed during projection")
            }
            rows.insert(
                index,
                row.ok_or_else(|| anyhow!("native operations alert row is missing"))?,
            );
        }
    }
    Ok(OperationsAlertCache {
        lineage_sha256,
        revision: state.revision,
        dependency_sha256,
        classes,
        rows,
        total_count,
        critical_count,
        warning_count,
    })
}

/// Frozen flat selector used only by regression tests. It deliberately skips
/// every runtime cache, sidecar and parallel prepare path while retaining the
/// established entity presentation classifier. This keeps cache invalidation
/// and persisted-order selection independently observable without duplicating
/// gameplay presentation rules in production.
#[cfg(test)]
fn flat_full_alert_snapshot(
    state: &CoreState,
    base: &Map<String, Value>,
) -> anyhow::Result<OperationsAlertSnapshot> {
    let mut total_count = 0usize;
    let mut critical_count = 0usize;
    let mut warning_count = 0usize;
    let mut rows = Vec::new();
    for index in 0..state.entities.ids.len() {
        let entity = state.parse_entity(index)?;
        let (class, row) = evaluate_alert_entity(state, base, &entity, true)?;
        match class {
            AlertClass::Quiet => continue,
            AlertClass::Critical => {
                total_count = total_count
                    .checked_add(1)
                    .ok_or_else(|| anyhow!("native operations alert count overflow"))?;
                critical_count = critical_count
                    .checked_add(1)
                    .ok_or_else(|| anyhow!("native operations critical alert count overflow"))?;
            }
            AlertClass::Warning => {
                total_count = total_count
                    .checked_add(1)
                    .ok_or_else(|| anyhow!("native operations alert count overflow"))?;
                warning_count = warning_count
                    .checked_add(1)
                    .ok_or_else(|| anyhow!("native operations warning alert count overflow"))?;
            }
        }
        if rows.len() < MAX_ALERT_ROWS {
            rows.push(
                row.ok_or_else(|| anyhow!("native operations flat alert row is missing"))?
                    .to_value(),
            );
        }
    }
    for index in 0..state.belts.ids.len() {
        let belt = state.parse_belt(index)?;
        let planet_id = required_text(belt.get("planetId"), "belt planet ID")?;
        if !state
            .catalog
            .planets
            .iter()
            .any(|planet| planet.id == planet_id)
        {
            bail!("native operations belt planet is outside the catalog")
        }
    }
    let overflow = total_count > MAX_ALERT_ROWS;
    if overflow {
        rows.clear();
    }
    Ok(OperationsAlertSnapshot {
        overflow,
        total_count,
        critical_count,
        warning_count,
        rows,
    })
}

fn adjust_counts(
    class: AlertClass,
    total: &mut usize,
    critical: &mut usize,
    warning: &mut usize,
    add: bool,
) -> anyhow::Result<()> {
    let update = |value: &mut usize| -> anyhow::Result<()> {
        *value = if add {
            value
                .checked_add(1)
                .ok_or_else(|| anyhow!("native operations alert count overflow"))?
        } else {
            value
                .checked_sub(1)
                .ok_or_else(|| anyhow!("native operations alert count underflow"))?
        };
        Ok(())
    };
    match class {
        AlertClass::Quiet => Ok(()),
        AlertClass::Critical => {
            update(total)?;
            update(critical)
        }
        AlertClass::Warning => {
            update(total)?;
            update(warning)
        }
    }
}

impl OperationsProjectionRuntime {
    fn lock(&self) -> MutexGuard<'_, OperationsProjectionRuntimeState> {
        self.0.lock().unwrap_or_else(|error| error.into_inner())
    }

    fn snapshot(
        &self,
        state: &CoreState,
        base: &Map<String, Value>,
        runtime: &DeterministicRuntime,
    ) -> anyhow::Result<(OperationsAlertSnapshot, bool)> {
        let lineage_sha256 = operations_lineage_sha256(state)?;
        let mut runtime_state = self.lock();
        let cache_hit = runtime_state.cache.as_ref().is_some_and(|cache| {
            cache.lineage_sha256 == lineage_sha256
                && cache.revision == state.revision
                && cache.classes.len() == state.entities.ids.len()
        });
        if cache_hit {
            runtime_state.diagnostics = OperationsProjectionDiagnostics {
                mode: "same-revision-cache",
                entity_rows_visited: 0,
                belt_rows_visited: 0,
                selected_worker_count: 0,
            };
            return runtime_state
                .cache
                .as_ref()
                .map(OperationsAlertCache::snapshot)
                .map(|snapshot| (snapshot, false))
                .ok_or_else(|| anyhow!("native operations alert cache is missing"));
        }
        let dependency_sha256 = alert_dependency_sha256(base)?;
        {
            let cache = build_alert_cache_with_runtime(state, base, dependency_sha256, runtime)?;
            runtime_state.diagnostics = OperationsProjectionDiagnostics {
                mode: "flat-full",
                entity_rows_visited: state.entities.ids.len(),
                belt_rows_visited: state.belts.ids.len(),
                selected_worker_count: runtime
                    .worker_count_for_items(state.entities.ids.len().max(state.belts.ids.len())),
            };
            if std::env::var_os("DSP_NATIVE_CORE_PROFILE").is_some() {
                eprintln!(
                    "DSP_NATIVE_CORE_PROFILE\toperations-projection-flat-full\tentities={}\tbelts={}\tworkers={}",
                    state.entities.ids.len(),
                    state.belts.ids.len(),
                    runtime_state.diagnostics.selected_worker_count,
                );
            }
            runtime_state.cache = Some(cache);
        }
        runtime_state
            .cache
            .as_ref()
            .map(OperationsAlertCache::snapshot)
            .map(|snapshot| (snapshot, true))
            .ok_or_else(|| anyhow!("native operations alert cache is missing"))
    }

    pub(crate) fn prepare_simulation_update(
        &self,
        state: &CoreState,
        next_base: &Map<String, Value>,
        next_entities: &[Value],
        changed_indices: &[usize],
        next_revision: u64,
    ) -> anyhow::Result<PreparedOperationsProjectionUpdate> {
        {
            let runtime_state = self.lock();
            if runtime_state.cache.as_ref().is_none_or(|cache| {
                cache.revision != state.revision
                    || cache.classes.len() != state.entities.ids.len()
                    || next_entities.len() != state.entities.ids.len()
            }) {
                return Ok(PreparedOperationsProjectionUpdate(
                    PreparedOperationsProjectionUpdateInner::Reset {
                        entity_rows_visited: 0,
                    },
                ));
            }
        }
        // A dense revision intentionally falls back to the flat oracle.  Make
        // that decision before constructing the bounded-but-global semantic
        // dependency digest; no digest can change the Reset outcome.
        if changed_indices
            .len()
            .saturating_mul(INCREMENTAL_DENSE_DENOMINATOR)
            >= next_entities
                .len()
                .saturating_mul(INCREMENTAL_DENSE_NUMERATOR)
            && !next_entities.is_empty()
        {
            return Ok(PreparedOperationsProjectionUpdate(
                PreparedOperationsProjectionUpdateInner::Reset {
                    entity_rows_visited: 0,
                },
            ));
        }
        let lineage_sha256 = operations_lineage_sha256(state)?;
        let dependency_sha256 = alert_dependency_sha256(next_base)?;
        let runtime_state = self.lock();
        let Some(cache) = runtime_state.cache.as_ref().filter(|cache| {
            cache.lineage_sha256 == lineage_sha256
                && cache.revision == state.revision
                && cache.classes.len() == state.entities.ids.len()
                && next_entities.len() == state.entities.ids.len()
                && cache.dependency_sha256 == dependency_sha256
        }) else {
            return Ok(PreparedOperationsProjectionUpdate(
                PreparedOperationsProjectionUpdateInner::Reset {
                    entity_rows_visited: 0,
                },
            ));
        };
        let mut changes = Vec::with_capacity(changed_indices.len());
        let mut total_count = cache.total_count;
        let mut critical_count = cache.critical_count;
        let mut warning_count = cache.warning_count;
        let mut previous = None;
        for &index in changed_indices {
            if index >= next_entities.len() || previous.is_some_and(|value| value >= index) {
                bail!("native operations changed entity rows are not strict persisted order")
            }
            previous = Some(index);
            let (class, _) = evaluate_alert_entity(state, next_base, &next_entities[index], false)?;
            let old_class = cache.classes[index];
            adjust_counts(
                old_class,
                &mut total_count,
                &mut critical_count,
                &mut warning_count,
                false,
            )?;
            adjust_counts(
                class,
                &mut total_count,
                &mut critical_count,
                &mut warning_count,
                true,
            )?;
            changes.push(PreparedAlertChange {
                index,
                class,
                row: None,
            });
        }
        let mut entity_rows_visited = changes.len();
        let rebuilt_rows = if cache.overflowed() && total_count <= MAX_ALERT_ROWS {
            let mut rows = BTreeMap::new();
            let changes_by_index = changes
                .iter()
                .map(|change| (change.index, change))
                .collect::<BTreeMap<_, _>>();
            for (index, old_class) in cache.classes.iter().copied().enumerate() {
                let class = changes_by_index
                    .get(&index)
                    .map_or(old_class, |change| change.class);
                if class == AlertClass::Quiet {
                    continue;
                }
                entity_rows_visited = entity_rows_visited
                    .checked_add(1)
                    .ok_or_else(|| anyhow!("native operations alert visit count overflow"))?;
                let (confirmed, row) =
                    evaluate_alert_entity(state, next_base, &next_entities[index], true)?;
                if confirmed != class {
                    bail!("native operations alert class drifted during overflow recovery")
                }
                let row =
                    row.ok_or_else(|| anyhow!("native operations recovered alert row is missing"))?;
                rows.insert(index, row);
            }
            Some(rows)
        } else {
            None
        };
        if !cache.overflowed() && total_count <= MAX_ALERT_ROWS {
            for change in &mut changes {
                if change.class == AlertClass::Quiet {
                    continue;
                }
                entity_rows_visited = entity_rows_visited
                    .checked_add(1)
                    .ok_or_else(|| anyhow!("native operations alert visit count overflow"))?;
                let (confirmed, row) =
                    evaluate_alert_entity(state, next_base, &next_entities[change.index], true)?;
                if confirmed != change.class {
                    bail!(
                        "native operations changed alert class drifted during row materialization"
                    )
                }
                change.row =
                    Some(row.ok_or_else(|| {
                        anyhow!("native operations changed alert row is missing")
                    })?);
            }
        }
        Ok(PreparedOperationsProjectionUpdate(
            PreparedOperationsProjectionUpdateInner::Incremental {
                expected_revision: state.revision,
                revision: next_revision,
                lineage_sha256,
                dependency_sha256,
                changes,
                total_count,
                critical_count,
                warning_count,
                entity_rows_visited,
                rebuilt_rows,
            },
        ))
    }

    pub(crate) fn install_simulation_update(&self, update: PreparedOperationsProjectionUpdate) {
        let mut runtime_state = self.lock();
        match update.0 {
            PreparedOperationsProjectionUpdateInner::Reset {
                entity_rows_visited,
            } => {
                runtime_state.cache = None;
                runtime_state.diagnostics = OperationsProjectionDiagnostics {
                    mode: "invalidated",
                    entity_rows_visited,
                    belt_rows_visited: 0,
                    selected_worker_count: 0,
                };
            }
            PreparedOperationsProjectionUpdateInner::Incremental {
                expected_revision,
                revision,
                lineage_sha256,
                dependency_sha256,
                changes,
                total_count,
                critical_count,
                warning_count,
                entity_rows_visited,
                rebuilt_rows,
            } => {
                let Some(cache) = runtime_state.cache.as_mut().filter(|cache| {
                    cache.lineage_sha256 == lineage_sha256
                        && cache.revision == expected_revision
                        && cache.dependency_sha256 == dependency_sha256
                }) else {
                    runtime_state.cache = None;
                    runtime_state.diagnostics = OperationsProjectionDiagnostics {
                        mode: "invalidated",
                        entity_rows_visited: 0,
                        belt_rows_visited: 0,
                        selected_worker_count: 0,
                    };
                    return;
                };
                let old_overflow = cache.overflowed();
                let changed_count = changes.len();
                let recovered_from_overflow = rebuilt_rows.is_some();
                for change in &changes {
                    cache.classes[change.index] = change.class;
                }
                if total_count > MAX_ALERT_ROWS {
                    cache.rows.clear();
                } else if old_overflow {
                    let Some(rows) = rebuilt_rows else {
                        runtime_state.cache = None;
                        runtime_state.diagnostics = OperationsProjectionDiagnostics {
                            mode: "invalidated",
                            entity_rows_visited,
                            belt_rows_visited: 0,
                            selected_worker_count: 0,
                        };
                        return;
                    };
                    cache.rows = rows;
                } else {
                    for change in &changes {
                        match (&change.class, &change.row) {
                            (AlertClass::Quiet, _) => {
                                cache.rows.remove(&change.index);
                            }
                            (_, Some(row)) => {
                                cache.rows.insert(change.index, row.clone());
                            }
                            (_, None) => {
                                cache.rows.remove(&change.index);
                            }
                        }
                    }
                }
                cache.revision = revision;
                cache.total_count = total_count;
                cache.critical_count = critical_count;
                cache.warning_count = warning_count;
                if !cache.structurally_consistent() {
                    runtime_state.cache = None;
                    runtime_state.diagnostics = OperationsProjectionDiagnostics {
                        mode: "invalidated",
                        entity_rows_visited,
                        belt_rows_visited: 0,
                        selected_worker_count: 0,
                    };
                    return;
                }
                runtime_state.diagnostics = OperationsProjectionDiagnostics {
                    mode: if recovered_from_overflow {
                        "incremental-overflow-recovery"
                    } else if entity_rows_visited > changed_count {
                        "incremental-row-materialize"
                    } else {
                        "incremental"
                    },
                    entity_rows_visited,
                    belt_rows_visited: 0,
                    selected_worker_count: 1,
                };
            }
        }
    }

    pub(crate) fn estimated_bytes(&self) -> u64 {
        let runtime_state = self.lock();
        u64::try_from(size_of::<OperationsProjectionRuntimeState>())
            .unwrap_or(u64::MAX)
            .saturating_add(
                runtime_state
                    .cache
                    .as_ref()
                    .map(OperationsAlertCache::estimated_bytes)
                    .unwrap_or(0),
            )
    }

    pub(crate) fn invalidate(&self) {
        let mut runtime_state = self.lock();
        runtime_state.cache = None;
        runtime_state.diagnostics = OperationsProjectionDiagnostics {
            mode: "invalidated",
            entity_rows_visited: 0,
            belt_rows_visited: 0,
            selected_worker_count: 0,
        };
    }

    #[cfg(test)]
    pub(crate) fn diagnostics(&self) -> OperationsProjectionDiagnostics {
        self.lock().diagnostics
    }
}

#[cfg(test)]
fn alert_dependency_walk_count() -> usize {
    ALERT_DEPENDENCY_WALKS.with(std::cell::Cell::get)
}

#[cfg(test)]
fn reset_alert_dependency_walk_count() {
    ALERT_DEPENDENCY_WALKS.with(|count| count.set(0));
}

impl CoreState {
    pub fn operations_workspace_projection(
        &self,
        session_id: &str,
        run_id: &str,
        expected_revision: u64,
        expected_registry_fingerprint: &str,
    ) -> anyhow::Result<Value> {
        validate_text("projection session ID", session_id)?;
        validate_text("projection run ID", run_id)?;
        validate_text(
            "projection registry fingerprint",
            expected_registry_fingerprint,
        )?;
        if expected_revision != self.revision || expected_revision >= MAX_SAFE_INTEGER {
            bail!("native operations projection revision is stale")
        }
        require_operations_domain(self, expected_registry_fingerprint)?;
        let base = self.base_value();
        let settings = base
            .get("settings")
            .and_then(Value::as_object)
            .ok_or_else(|| anyhow!("native operations settings are invalid"))?;
        let settings_projection = project_settings(settings)?;
        let active_planet_id = required_text(base.get("activePlanetId"), "active planet")?;
        let active_planet_index = self
            .catalog
            .planets
            .iter()
            .position(|planet| planet.id == active_planet_id)
            .ok_or_else(|| anyhow!("native operations active planet is outside the catalog"))?;
        if self.factory_topology.catalog_sha256 != self.catalog.fingerprint {
            bail!("native operations factory topology catalog is stale")
        }
        let paused = base
            .get("paused")
            .and_then(Value::as_bool)
            .ok_or_else(|| anyhow!("native operations paused state is invalid"))?;
        let elapsed_seconds = safe_number(base.get("elapsedSeconds"), "elapsed seconds")?;
        let construction_queue_count =
            bounded_count(base.get("constructionQueue"), "construction queue")?;
        let entity_count = bounded_usize_count(self.entities.ids.len(), "entity")?;
        let belt_count = bounded_usize_count(self.belts.ids.len(), "belt")?;

        let active_planet_entity_count = self
            .factory_topology
            .entities_by_planet
            .get(active_planet_index)
            .map(Vec::len)
            .ok_or_else(|| anyhow!("native operations active entity index is invalid"))?;
        let active_planet_belt_count = self
            .factory_topology
            .belt_counts_by_planet
            .get(active_planet_index)
            .copied()
            .map(|count| count as usize)
            .ok_or_else(|| anyhow!("native operations active belt index is invalid"))?;
        let (alerts, cache_changed) =
            self.operations_projection_runtime
                .snapshot(self, base, deterministic_runtime())?;
        if cache_changed {
            self.invalidate_summary_cache();
        }
        let projection = json!({
            "schemaVersion": 1, "projectionType": OPERATIONS_WORKSPACE_PROJECTION,
            "source": "native-core", "sessionId": session_id, "runId": run_id,
            "revision": self.revision, "registryFingerprint": self.identity.registry_fingerprint,
            "stateVersion": self.identity.state_version, "truncated": false,
            "settings": settings_projection,
            "summary": {
                "paused": paused, "elapsedSeconds": elapsed_seconds,
                "entityCount": entity_count, "beltCount": belt_count,
                "activePlanetId": active_planet_id,
                "activePlanetEntityCount": active_planet_entity_count,
                "activePlanetBeltCount": active_planet_belt_count,
                "constructionQueueCount": construction_queue_count,
            },
            "alerts": {
                "status": if alerts.overflow { "overflow" } else { "complete" },
                "totalCount": alerts.total_count, "criticalCount": alerts.critical_count,
                "warningCount": alerts.warning_count, "rows": alerts.rows,
            },
            "limits": { "alertRows": MAX_ALERT_ROWS, "projectionBytes": MAX_PROJECTION_BYTES },
        });
        if serde_json::to_vec(&projection)?.len() > MAX_PROJECTION_BYTES {
            bail!("native operations projection exceeds its bounded byte limit")
        }
        Ok(projection)
    }
}

fn require_operations_domain(state: &CoreState, registry: &str) -> anyhow::Result<()> {
    if state.identity.state_version != 47
        || state.base_value().get("version").and_then(Value::as_u64) != Some(47)
        || state.base_value().get("mode").and_then(Value::as_str) != Some("normal")
    {
        bail!("native operations authority requires normal GameState v47")
    }
    if registry != state.identity.registry_fingerprint
        || registry != state.catalog.snapshot.registry_fingerprint
        || registry != EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT
    {
        bail!("native operations registry is stale or outside the built-in domain")
    }
    match state.base_value().get("contentPacks") {
        Some(Value::Array(packs)) if packs.is_empty() => Ok(()),
        _ => bail!("native operations authority does not support content packs"),
    }
}

fn project_settings(settings: &Map<String, Value>) -> anyhow::Result<Value> {
    let speed = integer(settings.get("simulationSpeed"), "simulation speed")?;
    if !matches!(speed, 1 | 2 | 4) {
        bail!("native operations simulation speed is invalid")
    }
    let layout = required_text(settings.get("technologyLayout"), "technology layout")?;
    if !matches!(layout, "standard" | "compact") {
        bail!("native operations technology layout is invalid")
    }
    let route = required_text(settings.get("defaultBeltRouteMode"), "belt route mode")?;
    if !matches!(route, "auto" | "bezier" | "upper" | "lower") {
        bail!("native operations belt route mode is invalid")
    }
    Ok(json!({
        "simulationSpeed": speed, "technologyLayout": layout, "defaultBeltRouteMode": route,
        "productionBufferLimit": bounded_buffer(settings, "productionBufferLimit", 1_000)?,
        "logisticsBufferLimit": bounded_buffer(settings, "logisticsBufferLimit", 1_000)?,
        "beltBufferLimit": bounded_buffer(settings, "beltBufferLimit", 1_000)?,
        "proliferatorBufferLimit": bounded_buffer(settings, "proliferatorBufferLimit", 1)?,
    }))
}

fn build_patch(
    state: &CoreState,
    intent: &OperationsSettingIntent,
) -> anyhow::Result<SimulationCommandPatch> {
    validate_intent(intent)?;
    let settings = state
        .base_value()
        .get("settings")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native operations settings are invalid"))?;
    project_settings(settings)?;
    let (field, target) = intent_target(intent);
    if settings.get(field) == Some(&target) {
        bail!("native operations setting target is unchanged")
    }
    Ok(SimulationCommandPatch {
        protocol_version: CORE_PROTOCOL_VERSION,
        base_revision: state.revision,
        top_level_changes: vec![ValuePatch {
            path: vec![
                PathSegment::Key("settings".to_owned()),
                PathSegment::Key(field.to_owned()),
            ],
            operation: "set".to_owned(),
            value: Some(target),
        }],
        changed_entities: Vec::new(),
        added_entities: Vec::new(),
        removed_entity_ids: Vec::new(),
        changed_belts: Vec::new(),
        added_belts: Vec::new(),
        removed_belt_ids: Vec::new(),
    })
}

fn intent_target(intent: &OperationsSettingIntent) -> (&'static str, Value) {
    match intent {
        OperationsSettingIntent::SetSimulationSpeed { value } => ("simulationSpeed", json!(value)),
        OperationsSettingIntent::SetTechnologyLayout { value } => {
            ("technologyLayout", json!(value))
        }
        OperationsSettingIntent::SetDefaultBeltRouteMode { value } => {
            ("defaultBeltRouteMode", json!(value))
        }
        OperationsSettingIntent::SetProductionBufferLimit { value } => {
            ("productionBufferLimit", json!(value))
        }
        OperationsSettingIntent::SetLogisticsBufferLimit { value } => {
            ("logisticsBufferLimit", json!(value))
        }
        OperationsSettingIntent::SetBeltBufferLimit { value } => ("beltBufferLimit", json!(value)),
        OperationsSettingIntent::SetProliferatorBufferLimit { value } => {
            ("proliferatorBufferLimit", json!(value))
        }
    }
}

fn validate_intent(intent: &OperationsSettingIntent) -> anyhow::Result<()> {
    match intent {
        OperationsSettingIntent::SetSimulationSpeed { value: 1 | 2 | 4 } => Ok(()),
        OperationsSettingIntent::SetTechnologyLayout { value }
            if matches!(value.as_str(), "standard" | "compact") =>
        {
            Ok(())
        }
        OperationsSettingIntent::SetDefaultBeltRouteMode { value }
            if matches!(value.as_str(), "auto" | "bezier" | "upper" | "lower") =>
        {
            Ok(())
        }
        OperationsSettingIntent::SetProductionBufferLimit { value }
        | OperationsSettingIntent::SetLogisticsBufferLimit { value }
        | OperationsSettingIntent::SetBeltBufferLimit { value }
            if (1_000..=100_000_000).contains(value) =>
        {
            Ok(())
        }
        OperationsSettingIntent::SetProliferatorBufferLimit { value }
            if (1..=100_000_000).contains(value) =>
        {
            Ok(())
        }
        _ => bail!("native operations setting intent is invalid"),
    }
}

fn validate_text(label: &str, value: &str) -> anyhow::Result<()> {
    if value.is_empty()
        || value.len() > MAX_TEXT_BYTES
        || value.chars().any(|c| c == '\0' || c.is_control())
    {
        bail!("native operations {label} is invalid")
    }
    Ok(())
}
fn required_text<'a>(value: Option<&'a Value>, label: &str) -> anyhow::Result<&'a str> {
    let value = value
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("native operations {label} is invalid"))?;
    validate_text(label, value)?;
    Ok(value)
}
fn integer(value: Option<&Value>, label: &str) -> anyhow::Result<u64> {
    value
        .and_then(Value::as_u64)
        .filter(|v| *v <= MAX_SAFE_INTEGER)
        .ok_or_else(|| anyhow!("native operations {label} is invalid"))
}
fn bounded_buffer(settings: &Map<String, Value>, field: &str, minimum: u64) -> anyhow::Result<u64> {
    let value = integer(settings.get(field), field)?;
    if !(minimum..=100_000_000).contains(&value) {
        bail!("native operations {field} is outside bounds")
    }
    Ok(value)
}
fn safe_number(value: Option<&Value>, label: &str) -> anyhow::Result<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|v| v.is_finite() && *v >= 0.0 && *v <= MAX_SAFE_INTEGER as f64)
        .ok_or_else(|| anyhow!("native operations {label} is invalid"))
}
fn bounded_count(value: Option<&Value>, label: &str) -> anyhow::Result<usize> {
    let rows = value
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("native operations {label} is invalid"))?;
    bounded_usize_count(rows.len(), label)
}
fn bounded_usize_count(value: usize, label: &str) -> anyhow::Result<usize> {
    let count =
        u64::try_from(value).map_err(|_| anyhow!("native operations {label} count is invalid"))?;
    if count > MAX_SAFE_INTEGER {
        bail!("native operations {label} count is invalid")
    }
    Ok(value)
}
fn sha256_json(value: &impl Serialize) -> anyhow::Result<String> {
    let bytes = serde_json::to_vec(value)?;
    let mut digest = Sha256::new();
    digest.update(bytes);
    Ok(format!("{:x}", digest.finalize()))
}

#[cfg(test)]
mod tests {
    use std::collections::{BTreeMap, HashMap};
    use std::sync::Arc;
    use std::time::Instant;

    use super::*;
    use crate::catalog::{
        BeltDefinition, BuildingDefinition, CatalogSnapshot, ItemAmount, ItemDefinition,
        PlanetDefinition, RecipeDefinition, RuntimeCatalog,
    };
    use crate::command::{AddedRecord, SimulationCommandPatch};
    use crate::deterministic_runtime::DeterministicRuntime;
    use crate::state::CoreCheckpointIdentity;

    fn fixture_catalog() -> RuntimeCatalog {
        RuntimeCatalog::validate(
            CatalogSnapshot {
                protocol_version: CORE_PROTOCOL_VERSION,
                registry_fingerprint: EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT.to_owned(),
                planets: vec![
                    PlanetDefinition {
                        id: "home".to_owned(),
                        name: "Home".to_owned(),
                        system_id: "helios".to_owned(),
                        kind: "terrestrial".to_owned(),
                        orbit_index: 1,
                        simulation_order: 0,
                        orbital_yields: HashMap::new(),
                    },
                    PlanetDefinition {
                        id: "ashen".to_owned(),
                        name: "Ashen".to_owned(),
                        system_id: "helios".to_owned(),
                        kind: "terrestrial".to_owned(),
                        orbit_index: 2,
                        simulation_order: 1,
                        orbital_yields: HashMap::new(),
                    },
                ],
                items: vec![ItemDefinition {
                    id: "iron_ore".to_owned(),
                    name: "Iron ore".to_owned(),
                    kind: "solid".to_owned(),
                    fuel_energy_mj: 0.0,
                }],
                buildings: vec![BuildingDefinition {
                    id: "mining_machine".to_owned(),
                    kind: "miner".to_owned(),
                    speed: 1.0,
                    input_capacity: 0.0,
                    output_capacity: 5_000.0,
                    power_demand_kw: 1.0,
                    power_generation_kw: 0.0,
                    power_charge_kw: 0.0,
                    energy_capacity_mj: 0.0,
                    fuel_item_ids: Vec::new(),
                    fuel_efficiency: 1.0,
                    family: None,
                    accepts: None,
                }],
                recipes: Vec::new(),
                constructions: Vec::new(),
                belts: vec![BeltDefinition {
                    tier: 1,
                    speed: 6.0,
                }],
                proliferators: Vec::new(),
                technologies: Vec::new(),
            },
            EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT,
        )
        .unwrap()
    }

    fn fixture_identity(revision: u64) -> CoreCheckpointIdentity {
        CoreCheckpointIdentity {
            slot: "normal-main".to_owned(),
            generation: 7,
            root_hash: "a".repeat(64),
            revision,
            state_version: 47,
            mode: "normal".to_owned(),
            registry_fingerprint: EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT.to_owned(),
            base_primary_checksum: "12345678".to_owned(),
        }
    }

    fn fixture_base() -> Map<String, Value> {
        json!({
            "version": 47,
            "mode": "normal",
            "activePlanetId": "home",
            "elapsedSeconds": 120,
            "paused": false,
            "contentPacks": [],
            "settings": {
                "simulationSpeed": 1,
                "technologyLayout": "standard",
                "defaultBeltRouteMode": "auto",
                "productionBufferLimit": 1_000,
                "logisticsBufferLimit": 1_000,
                "beltBufferLimit": 1_000,
                "proliferatorBufferLimit": 1,
                "resourceMode": "finite"
            },
            "constructionQueue": [],
            "tray": {},
            "planetTrays": { "home": {}, "ashen": {} },
            "powerGridMetrics": {
                "home": { "grid-a": { "powerFactor": 1.0 } },
                "ashen": { "grid-a": { "powerFactor": 1.0 } }
            },
            "planetMetrics": {
                "home": { "powerFactor": 1.0 },
                "ashen": { "powerFactor": 1.0 }
            },
            "endgame": { "infiniteResearch": { "vein_utilization": { "level": 0 } } },
            "galaxy": { "profiles": {
                "home": { "oceanType": "none" },
                "ashen": { "oceanType": "none" }
            } },
            "dysonEngineering": {
                "launchEnabled": true,
                "orbitsBySystem": {
                    "helios": [{ "id": "orbit-a", "name": "Original" }]
                }
            },
            "constructionAutomation": { "enabled": false, "jobs": {} },
            "timeWarp": {
                "controllerEntityId": null,
                "enabled": false,
                "effectiveMultiplier": 1
            },
            "research": { "selectedTechId": null, "completedTechIds": [] }
        })
        .as_object()
        .unwrap()
        .clone()
    }

    fn fixture_entity(index: usize, critical: bool, warning: bool) -> Value {
        let planet_id = if index.is_multiple_of(2) {
            "home"
        } else {
            "ashen"
        };
        let mut value = json!({
            "id": format!("vein-{index:06}"),
            "kind": "vein",
            "planetId": planet_id,
            "position": { "x": index % 256, "y": index / 256 },
            "resourceId": "iron_ore",
            "minerCount": 1,
            "inputs": {},
            "outputs": if critical { json!({ "iron_ore": 1_000 }) } else { json!({}) },
            "resourceRemaining": 10_000,
            "resourceCapacity": 10_000
        });
        if warning {
            value["powerFactor"] = json!(0.5);
        }
        value
    }

    fn fixture_belt(index: usize, entity_count: usize) -> Value {
        let source = index % entity_count;
        let target = (index + 1) % entity_count;
        json!({
            "id": format!("belt-{index:06}"),
            "planetId": if source.is_multiple_of(2) { "home" } else { "ashen" },
            "source": format!("vein-{source:06}"),
            "target": format!("vein-{target:06}"),
            "itemId": "iron_ore",
            "lanes": 1,
            "tier": 1,
            "priority": 1,
            "progress": 0,
            "lastFlow": 0
        })
    }

    fn fixture_state(
        entity_count: usize,
        critical_count: usize,
        warning_count: usize,
        belt_count: usize,
    ) -> CoreState {
        assert!(critical_count + warning_count <= entity_count);
        assert!(belt_count == 0 || entity_count > 0);
        let entities = (0..entity_count)
            .map(|index| {
                fixture_entity(
                    index,
                    index < critical_count,
                    (critical_count..critical_count + warning_count).contains(&index),
                )
                .to_string()
            })
            .collect::<Vec<_>>();
        let belts = (0..belt_count)
            .map(|index| fixture_belt(index, entity_count).to_string())
            .collect::<Vec<_>>();
        CoreState::from_public_v47_parts(
            fixture_identity(17),
            fixture_base(),
            entities,
            belts,
            fixture_catalog(),
        )
        .unwrap()
    }

    fn malformed_optional_identity_machine_state() -> CoreState {
        let mut snapshot = fixture_catalog().snapshot;
        snapshot.buildings.push(BuildingDefinition {
            id: "test_machine".to_owned(),
            kind: "machine".to_owned(),
            speed: 1.0,
            input_capacity: 100.0,
            output_capacity: 5_000.0,
            power_demand_kw: 1.0,
            power_generation_kw: 0.0,
            power_charge_kw: 0.0,
            energy_capacity_mj: 0.0,
            fuel_item_ids: Vec::new(),
            fuel_efficiency: 1.0,
            family: None,
            accepts: None,
        });
        snapshot.recipes.push(RecipeDefinition {
            id: "test_recipe".to_owned(),
            name: "Test recipe".to_owned(),
            building_id: "test_machine".to_owned(),
            duration: 1.0,
            required_tech_id: None,
            recursive_priority: 0.0,
            recursive_manufacturing: false,
            inputs: vec![ItemAmount {
                item_id: "iron_ore".to_owned(),
                amount: 1.0,
            }],
            outputs: vec![ItemAmount {
                item_id: "iron_ore".to_owned(),
                amount: 1.0,
            }],
        });
        let catalog =
            RuntimeCatalog::validate(snapshot, EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT).unwrap();
        CoreState::from_public_v47_parts(
            fixture_identity(17),
            fixture_base(),
            vec![
                json!({
                    "id": "machine-opaque",
                    "kind": "machine",
                    "planetId": "home",
                    "buildingId": "test_machine",
                    "recipeId": "test_recipe",
                    "resourceId": 42,
                    "inputs": { "iron_ore": 1 },
                    "outputs": {},
                    "progress": 0,
                    "utilization": 0,
                    "productionRate": 0,
                    "routingCursor": 0
                })
                .to_string(),
            ],
            Vec::new(),
            catalog,
        )
        .unwrap()
    }

    fn projection(state: &CoreState) -> Value {
        state
            .operations_workspace_projection(
                "core-main-1",
                "run-1",
                state.revision,
                EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT,
            )
            .unwrap()
    }

    fn alert_snapshot_value(snapshot: OperationsAlertSnapshot) -> Value {
        json!({
            "status": if snapshot.overflow { "overflow" } else { "complete" },
            "totalCount": snapshot.total_count,
            "criticalCount": snapshot.critical_count,
            "warningCount": snapshot.warning_count,
            "rows": snapshot.rows,
        })
    }

    fn assert_matches_flat_oracle(state: &CoreState, value: &Value) {
        let expected = flat_full_alert_snapshot(state, state.base_value()).unwrap();
        assert_eq!(value["alerts"], alert_snapshot_value(expected));
        let active_planet_id = state.base_value()["activePlanetId"].as_str().unwrap();
        let active_entities = (0..state.entities.ids.len())
            .filter(|&index| {
                state.parse_entity(index).unwrap()["planetId"].as_str() == Some(active_planet_id)
            })
            .count();
        let active_belts = (0..state.belts.ids.len())
            .filter(|&index| {
                state.parse_belt(index).unwrap()["planetId"].as_str() == Some(active_planet_id)
            })
            .count();
        assert_eq!(value["summary"]["entityCount"], state.entities.ids.len());
        assert_eq!(value["summary"]["beltCount"], state.belts.ids.len());
        assert_eq!(value["summary"]["activePlanetEntityCount"], active_entities);
        assert_eq!(value["summary"]["activePlanetBeltCount"], active_belts);
    }

    fn checkpoint_records(state: &CoreState) -> BTreeMap<String, Vec<u8>> {
        let mut records = BTreeMap::new();
        state
            .visit_internal_checkpoint_records(1_000, |key, value| {
                records.insert(key.to_owned(), value.as_bytes().to_vec());
                Ok(())
            })
            .unwrap();
        records
    }

    fn install_entity_changes(
        state: &mut CoreState,
        changes: &[(usize, Value)],
    ) -> OperationsProjectionDiagnostics {
        let mut next_entities = (0..state.entities.ids.len())
            .map(|index| state.parse_entity(index).unwrap())
            .collect::<Vec<_>>();
        let mut changed_indices = Vec::with_capacity(changes.len());
        for (index, value) in changes {
            next_entities[*index] = value.clone();
            changed_indices.push(*index);
        }
        let update = state
            .operations_projection_runtime
            .prepare_simulation_update(
                state,
                state.base_value(),
                &next_entities,
                &changed_indices,
                state.revision + 1,
            )
            .unwrap();
        let runtime = std::mem::take(&mut state.operations_projection_runtime);
        for (index, value) in changes {
            state.replace_entity_raw(*index, value.to_string().into());
        }
        state.revision += 1;
        runtime.install_simulation_update(update);
        let diagnostics = runtime.diagnostics();
        state.operations_projection_runtime = runtime;
        diagnostics
    }

    fn request(intent: OperationsSettingIntent) -> OperationsSettingCommandRequest {
        OperationsSettingCommandRequest {
            command_id: "operations-setting-v1-placeholder".to_owned(),
            session_id: "core-main-1".to_owned(),
            run_id: "run-1".to_owned(),
            expected_revision: 17,
            expected_registry_fingerprint: EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT.to_owned(),
            intent,
        }
    }

    #[test]
    fn semantic_identity_covers_lineage_and_exact_leaf_intent() {
        let mut value = request(OperationsSettingIntent::SetProductionBufferLimit { value: 1_000 });
        let first = derive_operations_setting_command_id(&value).unwrap();
        assert_eq!(
            first,
            "operations-setting-v1-b6eaf052d3c25f0ba8447935a74127eb9ab108fed18b5ade3303330554c6b13c"
        );
        value.run_id = "run-2".to_owned();
        assert_ne!(derive_operations_setting_command_id(&value).unwrap(), first);
        value.run_id = "run-1".to_owned();
        value.intent = OperationsSettingIntent::SetProductionBufferLimit { value: 1_001 };
        assert_ne!(derive_operations_setting_command_id(&value).unwrap(), first);
    }

    #[test]
    fn serde_and_bounds_fail_closed_for_extra_or_destructive_intents() {
        assert!(
            serde_json::from_value::<OperationsSettingIntent>(json!({
                "type": "set-simulation-speed", "value": 2, "patch": {}
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<OperationsSettingIntent>(json!({
                "type": "set-resource-mode", "value": "infinite"
            }))
            .is_err()
        );
        assert!(
            validate_intent(&OperationsSettingIntent::SetProductionBufferLimit { value: 999 })
                .is_err()
        );
        assert!(
            validate_intent(&OperationsSettingIntent::SetProliferatorBufferLimit { value: 0 })
                .is_err()
        );
        assert!(
            validate_intent(&OperationsSettingIntent::SetBeltBufferLimit { value: 100_000_001 })
                .is_err()
        );
    }

    #[test]
    fn same_revision_cache_is_hash_neutral_checkpoint_neutral_and_memory_visible() {
        let state = fixture_state(64, 2, 1, 7);
        let before_hash = state.canonical_sha256().unwrap();
        let before_public = state.materialize().unwrap();
        let before_records = checkpoint_records(&state);
        state.invalidate_summary_cache();
        let before_summary = state.summary().unwrap();
        let before_runtime = state.operations_projection_runtime.estimated_bytes();

        reset_alert_dependency_walk_count();
        let first = projection(&state);
        assert_eq!(alert_dependency_walk_count(), 1);
        assert_matches_flat_oracle(&state, &first);
        assert_eq!(
            state.operations_projection_runtime.diagnostics(),
            OperationsProjectionDiagnostics {
                mode: "flat-full",
                entity_rows_visited: 64,
                belt_rows_visited: 7,
                selected_worker_count: 1,
            }
        );
        assert_eq!(state.canonical_sha256().unwrap(), before_hash);
        assert_eq!(state.materialize().unwrap(), before_public);
        assert_eq!(checkpoint_records(&state), before_records);

        let after_summary = state.summary().unwrap();
        let after_runtime = state.operations_projection_runtime.estimated_bytes();
        assert!(after_runtime > before_runtime);
        assert_eq!(
            after_summary
                .memory
                .estimated_runtime_bytes
                .saturating_sub(before_summary.memory.estimated_runtime_bytes),
            after_runtime.saturating_sub(before_runtime)
        );

        let second = projection(&state);
        assert_eq!(alert_dependency_walk_count(), 1);
        assert_eq!(second, first);
        assert_eq!(
            state.operations_projection_runtime.diagnostics(),
            OperationsProjectionDiagnostics {
                mode: "same-revision-cache",
                entity_rows_visited: 0,
                belt_rows_visited: 0,
                selected_worker_count: 0,
            }
        );

        let cloned = state.clone();
        assert!(
            cloned.operations_projection_runtime.estimated_bytes()
                < state.operations_projection_runtime.estimated_bytes()
        );
        assert_eq!(
            cloned.summary().unwrap().memory.estimated_runtime_bytes,
            cloned.memory_estimate().estimated_runtime_bytes
        );
    }

    #[test]
    fn unopened_operations_cache_adds_zero_dependency_walks_to_exact_revisions() {
        let state = fixture_state(128, 2, 1, 4);
        let next_entities = (0..state.entities.ids.len())
            .map(|index| state.parse_entity(index).unwrap())
            .collect::<Vec<_>>();
        reset_alert_dependency_walk_count();
        let update = state
            .operations_projection_runtime
            .prepare_simulation_update(
                &state,
                state.base_value(),
                &next_entities,
                &[0],
                state.revision + 1,
            )
            .unwrap();
        assert!(update.is_reset());
        assert_eq!(alert_dependency_walk_count(), 0);
        projection(&state);
        assert_eq!(alert_dependency_walk_count(), 1);
    }

    #[test]
    fn segmented_1_5_60_incremental_updates_match_each_other_and_flat_oracle() {
        fn settle(segment: usize) -> (CoreState, Value) {
            let mut state = fixture_state(60, 0, 0, 8);
            projection(&state);
            for start in (0..60).step_by(segment) {
                let end = (start + segment).min(60);
                let changes = (start..end)
                    .map(|index| {
                        let mut entity = state.parse_entity(index).unwrap();
                        entity["outputs"] = json!({ "iron_ore": 1_000 });
                        (index, entity)
                    })
                    .collect::<Vec<_>>();
                let diagnostics = install_entity_changes(&mut state, &changes);
                assert!(matches!(
                    diagnostics.mode,
                    "incremental" | "incremental-row-materialize" | "invalidated"
                ));
                assert_eq!(diagnostics.belt_rows_visited, 0);
                assert!(
                    diagnostics.entity_rows_visited <= changes.len().saturating_add(MAX_ALERT_ROWS)
                );
            }
            let value = projection(&state);
            assert_matches_flat_oracle(&state, &value);
            (state, value)
        }

        let (one, one_projection) = settle(1);
        let (five, five_projection) = settle(5);
        let (sixty, sixty_projection) = settle(60);
        assert_eq!(one.materialize().unwrap(), five.materialize().unwrap());
        assert_eq!(five.materialize().unwrap(), sixty.materialize().unwrap());
        assert_eq!(one_projection["alerts"], five_projection["alerts"]);
        assert_eq!(five_projection["alerts"], sixty_projection["alerts"]);
        assert_eq!(one_projection["summary"], five_projection["summary"]);
        assert_eq!(five_projection["summary"], sixty_projection["summary"]);
    }

    #[test]
    fn every_global_alert_dependency_forces_transactional_reset_and_flat_rebuild() {
        type Mutator = fn(&mut Map<String, Value>);
        let cases: [(&str, Mutator); 19] = [
            ("paused", |base| {
                base.insert("paused".to_owned(), json!(true));
            }),
            ("production-buffer", |base| {
                base.get_mut("settings").unwrap()["productionBufferLimit"] = json!(2_000);
            }),
            ("logistics-buffer", |base| {
                base.get_mut("settings").unwrap()["logisticsBufferLimit"] = json!(2_000);
            }),
            ("resource-mode", |base| {
                base.get_mut("settings").unwrap()["resourceMode"] = json!("infinite");
            }),
            ("grid-power", |base| {
                base.get_mut("powerGridMetrics").unwrap()["home"]["grid-a"]["powerFactor"] =
                    json!(0.5);
            }),
            ("planet-power", |base| {
                base.get_mut("planetMetrics").unwrap()["home"]["powerFactor"] = json!(0.5);
            }),
            ("vein-utilization", |base| {
                base.get_mut("endgame").unwrap()["infiniteResearch"]["vein_utilization"]["level"] =
                    json!(10);
            }),
            ("ocean-type", |base| {
                base.get_mut("galaxy").unwrap()["profiles"]["home"]["oceanType"] = json!("water");
            }),
            ("dyson-launch", |base| {
                base.get_mut("dysonEngineering").unwrap()["launchEnabled"] = json!(false);
            }),
            ("dyson-orbit-label", |base| {
                base.get_mut("dysonEngineering").unwrap()["orbitsBySystem"] = json!({
                    "helios": [{ "id": "orbit-a", "name": "Renamed" }]
                });
            }),
            ("dyson-orbit-membership", |base| {
                base.get_mut("dysonEngineering").unwrap()["orbitsBySystem"] = json!({
                    "helios": [{ "id": "orbit-b", "name": "Original" }]
                });
            }),
            ("construction-enabled", |base| {
                base.get_mut("constructionAutomation").unwrap()["enabled"] = json!(true);
            }),
            ("construction-job-membership", |base| {
                base.get_mut("constructionAutomation").unwrap()["jobs"] = json!({ "center-a": {} });
            }),
            ("time-warp-controller", |base| {
                base.get_mut("timeWarp").unwrap()["controllerEntityId"] = json!("warp-a");
            }),
            ("time-warp-enabled", |base| {
                base.get_mut("timeWarp").unwrap()["enabled"] = json!(true);
            }),
            ("time-warp-effective", |base| {
                base.get_mut("timeWarp").unwrap()["effectiveMultiplier"] = json!(8);
            }),
            ("simulation-speed", |base| {
                base.get_mut("settings").unwrap()["simulationSpeed"] = json!(2);
            }),
            ("selected-tech-presence", |base| {
                base.get_mut("research").unwrap()["selectedTechId"] = json!("tech-a");
            }),
            ("completed-tech-membership", |base| {
                base.get_mut("research").unwrap()["completedTechIds"] = json!(["tech-a"]);
            }),
        ];

        for (label, mutate) in cases {
            let mut state = fixture_state(8, 1, 0, 2);
            projection(&state);
            let mut next_base = state.base_value().clone();
            mutate(&mut next_base);
            let next_entities = (0..state.entities.ids.len())
                .map(|index| state.parse_entity(index).unwrap())
                .collect::<Vec<_>>();
            let update = state
                .operations_projection_runtime
                .prepare_simulation_update(
                    &state,
                    &next_base,
                    &next_entities,
                    &[],
                    state.revision + 1,
                )
                .unwrap();
            assert!(update.is_reset(), "dependency case did not reset: {label}");
            let runtime = std::mem::take(&mut state.operations_projection_runtime);
            *state.base_value_mut() = next_base;
            state.revision += 1;
            runtime.install_simulation_update(update);
            state.operations_projection_runtime = runtime;
            let value = projection(&state);
            assert_matches_flat_oracle(&state, &value);
            assert_eq!(
                state.operations_projection_runtime.diagnostics().mode,
                "flat-full",
                "dependency case did not rebuild: {label}"
            );
        }
    }

    #[test]
    fn commands_reset_alerts_and_topology_counts_then_match_flat_oracle() {
        let mut state = fixture_state(4, 1, 0, 1);
        let before = projection(&state);
        assert_eq!(before["alerts"]["criticalCount"], 1);

        let authority = OperationsSettingAuthority {
            session_id: "core-main-1".to_owned(),
            run_id: "run-1".to_owned(),
        };
        let mut setting =
            request(OperationsSettingIntent::SetProductionBufferLimit { value: 2_000 });
        setting.command_id = derive_operations_setting_command_id(&setting).unwrap();
        let prepared = prepare_operations_setting_command(&state, &authority, setting).unwrap();
        prepared.apply(&mut state, &authority).unwrap();
        let after_setting = projection(&state);
        assert_matches_flat_oracle(&state, &after_setting);
        assert_eq!(after_setting["alerts"]["criticalCount"], 0);

        let added_entity = json!({
            "id": "vein-new",
            "kind": "vein",
            "planetId": "home",
            "position": { "x": 500, "y": 500 },
            "resourceId": "iron_ore",
            "minerCount": 1,
            "inputs": {},
            "outputs": {},
            "resourceRemaining": 10_000,
            "resourceCapacity": 10_000
        });
        let added_belt = json!({
            "id": "belt-new",
            "planetId": "home",
            "source": "vein-000002",
            "target": "vein-new",
            "itemId": "iron_ore",
            "lanes": 1,
            "tier": 1,
            "priority": 1,
            "progress": 0,
            "lastFlow": 0
        });
        let command = SimulationCommandPatch {
            protocol_version: CORE_PROTOCOL_VERSION,
            base_revision: state.revision,
            top_level_changes: Vec::new(),
            changed_entities: Vec::new(),
            added_entities: vec![AddedRecord {
                index: state.entities.ids.len(),
                value: added_entity,
            }],
            removed_entity_ids: Vec::new(),
            changed_belts: Vec::new(),
            added_belts: vec![AddedRecord {
                index: state.belts.ids.len(),
                value: added_belt,
            }],
            removed_belt_ids: Vec::new(),
        };
        let receipt = state.apply_command(&command).unwrap();
        assert!(receipt.topology_dirty);
        let after_topology = projection(&state);
        assert_matches_flat_oracle(&state, &after_topology);
        assert_eq!(after_topology["summary"]["entityCount"], 5);
        assert_eq!(after_topology["summary"]["beltCount"], 2);
        assert_eq!(after_topology["summary"]["activePlanetEntityCount"], 3);
        assert_eq!(after_topology["summary"]["activePlanetBeltCount"], 2);
    }

    #[test]
    fn failed_candidate_save_and_clone_leave_source_hash_rows_and_cache_unchanged() {
        let mut state = fixture_state(16, 2, 1, 3);
        let first = projection(&state);
        let before_hash = state.canonical_sha256().unwrap();
        let before_public = state.materialize().unwrap();
        let before_records = checkpoint_records(&state);
        let next_entities = (0..state.entities.ids.len())
            .map(|index| state.parse_entity(index).unwrap())
            .collect::<Vec<_>>();
        assert!(
            state
                .operations_projection_runtime
                .prepare_simulation_update(
                    &state,
                    state.base_value(),
                    &next_entities,
                    &[1, 0],
                    state.revision + 1,
                )
                .is_err()
        );
        let empty_command = SimulationCommandPatch {
            protocol_version: CORE_PROTOCOL_VERSION,
            base_revision: state.revision,
            top_level_changes: Vec::new(),
            changed_entities: Vec::new(),
            added_entities: Vec::new(),
            removed_entity_ids: Vec::new(),
            changed_belts: Vec::new(),
            added_belts: Vec::new(),
            removed_belt_ids: Vec::new(),
        };
        assert!(state.apply_command(&empty_command).is_err());
        let mut failed_candidate = state.clone();
        failed_candidate.base_value_mut()["paused"] = json!(true);
        let mut writes = 0usize;
        assert!(
            state
                .visit_internal_checkpoint_records(2_000, |_, _| {
                    writes += 1;
                    Err(anyhow!("injected save failure"))
                })
                .is_err()
        );
        assert_eq!(writes, 1);
        assert_eq!(state.canonical_sha256().unwrap(), before_hash);
        assert_eq!(state.materialize().unwrap(), before_public);
        assert_eq!(checkpoint_records(&state), before_records);
        assert_eq!(projection(&state), first);
        assert_eq!(
            state.operations_projection_runtime.diagnostics().mode,
            "same-revision-cache"
        );
    }

    #[test]
    fn projection_prepare_failure_never_changes_authoritative_commit_result() {
        let mut opened = malformed_optional_identity_machine_state();
        let mut unopened = opened.clone();
        let initial = projection(&opened);
        assert_eq!(initial["alerts"]["totalCount"], 0);

        fn consume_last_input(state: &mut CoreState) {
            let mut entities = state.parse_entities_parallel().unwrap();
            entities[0]["inputs"] = json!({});
            let base = state.base_value().clone();
            let next_revision = state.revision + 1;
            let belts = crate::belts::BeltCommitBatch::unchanged_for_test(state);
            state
                .commit_simulated_state(base, entities, belts, next_revision, false)
                .unwrap();
        }

        consume_last_input(&mut opened);
        consume_last_input(&mut unopened);

        assert_eq!(opened.revision, unopened.revision);
        assert_eq!(
            opened.canonical_sha256().unwrap(),
            unopened.canonical_sha256().unwrap()
        );
        assert_eq!(
            opened.materialize().unwrap(),
            unopened.materialize().unwrap()
        );
        assert_eq!(
            opened.operations_projection_runtime.diagnostics().mode,
            "invalidated"
        );
        assert!(
            opened
                .operations_workspace_projection(
                    "core-main-1",
                    "run-1",
                    opened.revision,
                    EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT,
                )
                .unwrap_err()
                .to_string()
                .contains("resource ID")
        );
    }

    #[test]
    fn sealed_install_gate_discards_an_internally_inconsistent_cache() {
        let mut state = fixture_state(16, 2, 0, 0);
        projection(&state);
        {
            let mut runtime = state.operations_projection_runtime.lock();
            runtime.cache.as_mut().unwrap().rows.remove(&0).unwrap();
        }
        let mut changed = state.parse_entity(5).unwrap();
        changed["outputs"] = json!({ "iron_ore": 1_000 });
        let diagnostics = install_entity_changes(&mut state, &[(5, changed)]);
        assert_eq!(diagnostics.mode, "invalidated");
        let rebuilt = projection(&state);
        assert_matches_flat_oracle(&state, &rebuilt);
        assert_eq!(rebuilt["alerts"]["totalCount"], 3);
    }

    #[test]
    fn checkpoint_reload_public_import_and_lineage_change_rebuild_from_flat_state() {
        let mut state = fixture_state(32, 3, 2, 5);
        let expected = projection(&state);
        let records = checkpoint_records(&state);
        let restored = CoreState::from_internal_records(
            fixture_identity(state.revision),
            &records,
            (*state.catalog).clone(),
        )
        .unwrap();
        let restored_projection = projection(&restored);
        assert_matches_flat_oracle(&restored, &restored_projection);
        assert_eq!(restored_projection["alerts"], expected["alerts"]);
        assert_eq!(
            restored.operations_projection_runtime.diagnostics().mode,
            "flat-full"
        );

        let mut public = state.materialize().unwrap().as_object().unwrap().clone();
        let entities = public
            .remove("entities")
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>();
        let belts = public
            .remove("belts")
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>();
        let imported = CoreState::from_public_v47_parts(
            fixture_identity(state.revision),
            public,
            entities,
            belts,
            (*state.catalog).clone(),
        )
        .unwrap();
        let imported_projection = projection(&imported);
        assert_matches_flat_oracle(&imported, &imported_projection);
        assert_eq!(imported_projection["alerts"], expected["alerts"]);

        state.install_checkpoint_identity(8, "b".repeat(64));
        let lineage_projection = projection(&state);
        assert_matches_flat_oracle(&state, &lineage_projection);
        assert_eq!(
            state.operations_projection_runtime.diagnostics().mode,
            "flat-full"
        );
    }

    #[test]
    fn opaque_content_pack_overflow_malformed_and_catalog_swap_fail_closed() {
        let mut opaque = fixture_state(2, 0, 0, 0);
        projection(&opaque);
        let mut entity = opaque.parse_entity(0).unwrap();
        entity["extractorBuildingId"] = json!("modded-miner");
        opaque.replace_entity_raw(0, entity.to_string().into());
        let opaque_projection = projection(&opaque);
        assert_matches_flat_oracle(&opaque, &opaque_projection);
        assert_eq!(opaque_projection["alerts"]["criticalCount"], 1);
        assert_eq!(
            opaque_projection["alerts"]["rows"][0]["code"],
            "unsupported-state"
        );

        opaque.base_value_mut()["contentPacks"] = json!([{ "id": "pack:test" }]);
        assert!(
            opaque
                .operations_workspace_projection(
                    "core-main-1",
                    "run-1",
                    opaque.revision,
                    EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT,
                )
                .is_err()
        );

        let mut overflow = fixture_state(1_025, 1_025, 0, 0);
        assert_eq!(projection(&overflow)["alerts"]["status"], "overflow");
        let mut malformed = overflow.parse_entity(1_024).unwrap();
        malformed["resourceId"] = json!(42);
        overflow.replace_entity_raw(1_024, malformed.to_string().into());
        assert!(
            overflow
                .operations_workspace_projection(
                    "core-main-1",
                    "run-1",
                    overflow.revision,
                    EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT,
                )
                .unwrap_err()
                .to_string()
                .contains("resource ID")
        );

        let mut catalog_swap = fixture_state(2, 0, 0, 0);
        projection(&catalog_swap);
        let mut snapshot = fixture_catalog().snapshot;
        snapshot.buildings[0].output_capacity = 6_000.0;
        let replacement =
            RuntimeCatalog::validate(snapshot, EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT).unwrap();
        assert_ne!(catalog_swap.catalog.fingerprint, replacement.fingerprint);
        catalog_swap.catalog = Arc::new(replacement);
        assert!(
            catalog_swap
                .operations_workspace_projection(
                    "core-main-1",
                    "run-1",
                    catalog_swap.revision,
                    EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT,
                )
                .unwrap_err()
                .to_string()
                .contains("topology catalog is stale")
        );
    }

    #[test]
    fn worker_1_2_4_8_flat_outputs_are_identical_and_memory_is_bounded() {
        let state = fixture_state(4_257, 1_000, 20, 200);
        let mut expected = None;
        for workers in [1, 2, 4, 8] {
            let runtime = DeterministicRuntime::for_test(workers);
            let projection_runtime = OperationsProjectionRuntime::default();
            let (snapshot, changed) = projection_runtime
                .snapshot(&state, state.base_value(), &runtime)
                .unwrap();
            assert!(changed);
            let value = alert_snapshot_value(snapshot);
            if let Some(expected) = &expected {
                assert_eq!(&value, expected);
            } else {
                expected = Some(value);
            }
            let diagnostics = projection_runtime.diagnostics();
            assert_eq!(diagnostics.mode, "flat-full");
            assert_eq!(diagnostics.entity_rows_visited, 4_257);
            assert_eq!(diagnostics.belt_rows_visited, 200);
            assert_eq!(diagnostics.selected_worker_count, workers);
            assert!(
                projection_runtime.estimated_bytes()
                    <= 4_257_u64 + (MAX_ALERT_ROWS as u64 * 2_048) + 16_384
            );
        }
        let flat =
            alert_snapshot_value(flat_full_alert_snapshot(&state, state.base_value()).unwrap());
        assert_eq!(expected.unwrap(), flat);
    }

    #[test]
    fn overflow_prepare_keeps_temporary_rows_bounded_and_recovery_is_exact() {
        let large = fixture_state(5_000, 5_000, 0, 0);
        projection(&large);
        let next_entities = (0..large.entities.ids.len())
            .map(|index| large.parse_entity(index).unwrap())
            .collect::<Vec<_>>();
        let update = large
            .operations_projection_runtime
            .prepare_simulation_update(
                &large,
                large.base_value(),
                &next_entities,
                &(0..3_000).collect::<Vec<_>>(),
                large.revision + 1,
            )
            .unwrap();
        assert!(!update.is_reset());
        assert_eq!(update.temporary_alert_row_count(), 0);
        assert!(large.operations_projection_runtime.estimated_bytes() < 64 * 1_024);

        let mut recovery = fixture_state(1_025, 1_025, 0, 0);
        projection(&recovery);
        let mut quiet = recovery.parse_entity(0).unwrap();
        quiet["outputs"] = json!({});
        let mut retained_alert = recovery.parse_entity(1).unwrap();
        retained_alert["resourceCapacity"] = json!(20_000);
        let diagnostics = install_entity_changes(&mut recovery, &[(0, quiet), (1, retained_alert)]);
        assert_eq!(diagnostics.mode, "incremental-overflow-recovery");
        assert_eq!(diagnostics.entity_rows_visited, 1_026);
        let value = projection(&recovery);
        assert_matches_flat_oracle(&recovery, &value);
        assert_eq!(value["alerts"]["status"], "complete");
        assert_eq!(value["alerts"]["totalCount"], 1_024);
        assert_eq!(value["alerts"]["rows"].as_array().unwrap().len(), 1_024);
    }

    #[test]
    #[ignore = "manual release-mode synthetic work-count and latency evidence"]
    fn synthetic_50k_operations_projection_benchmark() {
        let mut state = fixture_state(50_000, 1_000, 20, 5_000);
        let flat_started = Instant::now();
        let flat = flat_full_alert_snapshot(&state, state.base_value()).unwrap();
        let flat_elapsed = flat_started.elapsed();

        let cold_started = Instant::now();
        let cold = projection(&state);
        let cold_elapsed = cold_started.elapsed();
        assert_eq!(cold["alerts"], alert_snapshot_value(flat));

        reset_alert_dependency_walk_count();
        let cached_started = Instant::now();
        for _ in 0..20 {
            projection(&state);
        }
        let cached_elapsed = cached_started.elapsed();
        assert_eq!(alert_dependency_walk_count(), 0);
        assert_eq!(
            state
                .operations_projection_runtime
                .diagnostics()
                .entity_rows_visited,
            0
        );

        let mut next_entities = (0..state.entities.ids.len())
            .map(|index| state.parse_entity(index).unwrap())
            .collect::<Vec<_>>();
        next_entities[2_000]["outputs"] = json!({ "iron_ore": 1_000 });
        let incremental_started = Instant::now();
        let update = state
            .operations_projection_runtime
            .prepare_simulation_update(
                &state,
                state.base_value(),
                &next_entities,
                &[2_000],
                state.revision + 1,
            )
            .unwrap();
        let runtime = std::mem::take(&mut state.operations_projection_runtime);
        runtime.install_simulation_update(update);
        let diagnostics = runtime.diagnostics();
        let incremental_elapsed = incremental_started.elapsed();
        assert!(diagnostics.entity_rows_visited <= 2);
        assert_eq!(diagnostics.belt_rows_visited, 0);

        eprintln!(
            "OPERATIONS_PROJECTION_BENCH\tentities=50000\tbelts=5000\tflat_us={}\tcold_cache_us={}\tsame_revision_20_us={}\toperations_only_incremental_1_us={}\truntime_bytes={}",
            flat_elapsed.as_micros(),
            cold_elapsed.as_micros(),
            cached_elapsed.as_micros(),
            incremental_elapsed.as_micros(),
            runtime.estimated_bytes(),
        );
    }
}
