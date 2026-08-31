//! Bounded Operations read model and seven semantic settings intents.
//!
//! The renderer never supplies a GameState patch. Rust binds every read and
//! write to the active authority lineage and expands an accepted intent into
//! one exact settings-leaf patch for the Host durable transaction.

use anyhow::{anyhow, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::command::{
    EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT, PathSegment, SimulationCommandPatch, ValuePatch,
};
use crate::{CORE_PROTOCOL_VERSION, CommandApplyResult, CoreState};

pub const OPERATIONS_WORKSPACE_PROJECTION: &str = "operations-workspace-v1";
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_TEXT_BYTES: usize = 512;
const MAX_ALERT_ROWS: usize = 1_024;
const MAX_PROJECTION_BYTES: usize = 512 * 1_024;

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
        if !self
            .catalog
            .planets
            .iter()
            .any(|planet| planet.id == active_planet_id)
        {
            bail!("native operations active planet is outside the catalog")
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

        let mut rows = Vec::new();
        let mut total_count = 0usize;
        let mut critical_count = 0usize;
        let mut warning_count = 0usize;
        let mut active_planet_entity_count = 0usize;
        for index in 0..self.entities.ids.len() {
            let entity = self.parse_entity(index)?;
            let object = entity
                .as_object()
                .ok_or_else(|| anyhow!("native operations entity is invalid"))?;
            let entity_id = required_text(object.get("id"), "entity ID")?;
            let planet_id = required_text(object.get("planetId"), "entity planet ID")?;
            if !self
                .catalog
                .planets
                .iter()
                .any(|planet| planet.id == planet_id)
            {
                bail!("native operations entity planet is outside the catalog")
            }
            if planet_id == active_planet_id {
                active_planet_entity_count = active_planet_entity_count
                    .checked_add(1)
                    .ok_or_else(|| anyhow!("native operations active entity count overflow"))?;
            }
            let presentation = crate::factory_canvas_presentation::project_entity(
                &self.identity.registry_fingerprint,
                &self.catalog,
                base,
                &entity,
            );
            let (severity, code, label) =
                if presentation.get("supported").and_then(Value::as_bool) != Some(true) {
                    (
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
                            "critical",
                            required_text(status.get("code"), "alert code")?,
                            required_text(status.get("label"), "alert label")?,
                        ),
                        Some("warning") => (
                            "warning",
                            required_text(status.get("code"), "alert code")?,
                            required_text(status.get("label"), "alert label")?,
                        ),
                        Some("running" | "idle") => continue,
                        Some(_) => (
                            "critical",
                            "unsupported-state",
                            "状态无法证明，已按严重告警处理",
                        ),
                        None => bail!("native operations entity status tone is invalid"),
                    }
                };
            total_count = total_count
                .checked_add(1)
                .ok_or_else(|| anyhow!("native operations alert count overflow"))?;
            if severity == "critical" {
                critical_count = critical_count
                    .checked_add(1)
                    .ok_or_else(|| anyhow!("native operations critical alert count overflow"))?;
            } else {
                warning_count = warning_count
                    .checked_add(1)
                    .ok_or_else(|| anyhow!("native operations warning alert count overflow"))?;
            }
            if rows.len() < MAX_ALERT_ROWS {
                rows.push(json!({
                    "entityId": entity_id, "planetId": planet_id,
                    "buildingId": optional_text(object.get("buildingId"), "building ID")?,
                    "recipeId": optional_text(object.get("recipeId"), "recipe ID")?,
                    "resourceId": optional_text(object.get("resourceId"), "resource ID")?,
                    "severity": severity, "code": code, "label": label,
                }));
            }
        }
        let alert_overflow = total_count > MAX_ALERT_ROWS;
        if alert_overflow {
            rows.clear();
        }
        let mut active_planet_belt_count = 0usize;
        for index in 0..self.belts.ids.len() {
            let belt = self.parse_belt(index)?;
            let planet_id = required_text(belt.get("planetId"), "belt planet ID")?;
            if !self
                .catalog
                .planets
                .iter()
                .any(|planet| planet.id == planet_id)
            {
                bail!("native operations belt planet is outside the catalog")
            }
            if planet_id == active_planet_id {
                active_planet_belt_count = active_planet_belt_count
                    .checked_add(1)
                    .ok_or_else(|| anyhow!("native operations active belt count overflow"))?;
            }
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
                "status": if alert_overflow { "overflow" } else { "complete" },
                "totalCount": total_count, "criticalCount": critical_count,
                "warningCount": warning_count, "rows": rows,
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
fn optional_text(value: Option<&Value>, label: &str) -> anyhow::Result<Value> {
    match value {
        None | Some(Value::Null) => Ok(Value::Null),
        Some(Value::String(value)) => {
            validate_text(label, value)?;
            Ok(Value::String(value.clone()))
        }
        _ => bail!("native operations {label} is invalid"),
    }
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
    use super::*;

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
}
