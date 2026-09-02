//! Minimal, durable blueprint intents.
//!
//! The renderer sends the exact rename marker `{ kind, id, name }`, the exact
//! target-state transform marker `{ kind, id, rotation, mirror }`, the exact
//! recipe override marker `{ kind, id, sourceRecipeId, targetRecipeId }`, the
//! exact delete marker `{ kind, id, revision }`, or the exact native capture
//! marker `{ kind: "capture", entityIds, revision }`.
//! Rust validates the complete public-v47 blueprint directory and expands the
//! marker to an authoritative mutation. Rename and transform use ordinary leaf
//! patches. Delete and capture keep their validated mutations in private
//! Core-only plans, so the generic patch engine still forbids renderer-accessible
//! array mutation and no complete blueprint directory or captured body is copied
//! into the command. No blueprint body, version snapshot, queue, inventory,
//! entity, belt, or allocator field is renderer-derived.

use std::collections::{HashMap, HashSet};

use anyhow::{anyhow, bail};
use serde_json::{Map, Value, json};

use crate::{
    blueprint_import::{
        BlueprintImportMarker, BlueprintImportPlan, BlueprintImportPreparation,
        MAX_BLUEPRINT_IMPORT_COMMAND_BYTES, blueprint_allocator_available, parse_import_marker,
        prepare_import_marker,
    },
    blueprint_workspace::{
        validate_blueprint_directory, validate_queue_directory, validate_version_directory,
    },
    command::{PathSegment, SimulationCommandPatch, ValuePatch},
    construction_queue_command::{
        ordinary_blueprint_definition_has_no_internal_overlap,
        ordinary_blueprint_definition_supported_on_planet,
    },
    state::CoreState,
};

const BLUEPRINT_CAPTURE_CONTEXT_PROJECTION: &str = "blueprint-capture-context-v1";
const MAX_PROJECTION_BYTES: usize = 1_048_576;
const MAX_BLUEPRINT_ROWS: usize = 4_096;
const MAX_RECIPE_OVERRIDE_ROWS: usize = 4_096;
const MAX_OPAQUE_ID_BYTES: usize = 512;
const MAX_EXISTING_NAME_BYTES: usize = 256;
const MAX_RENAME_UTF16_UNITS: usize = 32;
const MAX_CAPTURE_ENTITIES: usize = 512;
const MAX_CAPTURE_BELTS: usize = 1_024;
const MAX_BUILDING_STACK_COUNT: u64 = 100_000_000;
const MAX_JAVASCRIPT_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, PartialEq, Eq)]
struct BlueprintRenameIntent {
    id: String,
    name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct BlueprintTransformIntent {
    id: String,
    rotation: u64,
    mirror: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct BlueprintDeleteIntent {
    id: String,
    revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct BlueprintRecipeOverrideIntent {
    id: String,
    source_recipe_id: String,
    target_recipe_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct BlueprintCaptureIntent {
    entity_ids: Vec<String>,
    revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum BlueprintIntent {
    Rename(BlueprintRenameIntent),
    Transform(BlueprintTransformIntent),
    RecipeOverride(BlueprintRecipeOverrideIntent),
    Delete(BlueprintDeleteIntent),
    Capture(BlueprintCaptureIntent),
    Import(BlueprintImportMarker),
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ValidatedBlueprintRename {
    index: usize,
    name: String,
    revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ValidatedBlueprintTransform {
    index: usize,
    rotation: u64,
    mirror: String,
    revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ValidatedBlueprintDelete {
    index: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ValidatedBlueprintRecipeOverride {
    index: usize,
    source_recipe_id: String,
    target_recipe_id: String,
    delete: bool,
    create_map: bool,
    revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct BlueprintCapturePlan {
    expected_next_id: u64,
    expected_library_len: usize,
    blueprint: Value,
    next_id_after: u64,
}

enum BlueprintCapturePreparation {
    Supported(BlueprintCapturePlan),
    Unsupported(&'static str),
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ValidatedBlueprintIntent {
    Rename(ValidatedBlueprintRename),
    Transform(ValidatedBlueprintTransform),
    RecipeOverride(ValidatedBlueprintRecipeOverride),
    Delete(ValidatedBlueprintDelete),
    Capture(BlueprintCapturePlan),
    Import(BlueprintImportPlan),
}

#[derive(Debug, Clone)]
enum BlueprintPrivateMutation {
    Delete { index: usize },
    Capture(BlueprintCapturePlan),
    Import(BlueprintImportPlan),
}

/// Core-only expansion of a validated semantic blueprint marker.
///
/// The private mutation is deliberately not serializable and never crosses the
/// Host or WAL boundary. It can only be produced after `validated_intent()` has
/// proved the complete blueprint directory and exact authoritative capture.
pub(crate) struct BlueprintCommandExpansion {
    command: SimulationCommandPatch,
    mutation: Option<BlueprintPrivateMutation>,
}

impl BlueprintCommandExpansion {
    pub(crate) fn command(&self) -> &SimulationCommandPatch {
        &self.command
    }

    pub(crate) fn requires_workspace_refresh(&self) -> bool {
        self.mutation.is_some()
    }

    pub(crate) fn apply_to_base(
        &self,
        state: &CoreState,
        base: &mut Map<String, Value>,
    ) -> anyhow::Result<()> {
        match &self.mutation {
            None => Ok(()),
            Some(BlueprintPrivateMutation::Delete { index }) => {
                let blueprints = base
                    .get_mut("blueprints")
                    .and_then(Value::as_array_mut)
                    .ok_or_else(|| {
                        anyhow!("native player-authority blueprint directory is invalid")
                    })?;
                if *index >= blueprints.len() {
                    bail!("native player-authority blueprint delete index is invalid")
                }
                blueprints.remove(*index);
                Ok(())
            }
            Some(BlueprintPrivateMutation::Capture(plan)) => {
                ensure_private_blueprint_allocator_available(state, base, &plan.blueprint)?;
                let current_next_id = base
                    .get("nextId")
                    .and_then(Value::as_u64)
                    .filter(|value| *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
                    .ok_or_else(|| {
                        anyhow!("native player-authority blueprint next ID is invalid")
                    })?;
                if current_next_id != plan.expected_next_id {
                    bail!("native player-authority blueprint capture allocator changed")
                }
                let blueprints = base
                    .get_mut("blueprints")
                    .and_then(Value::as_array_mut)
                    .ok_or_else(|| {
                        anyhow!("native player-authority blueprint directory is invalid")
                    })?;
                if blueprints.len() != plan.expected_library_len {
                    bail!("native player-authority blueprint capture library changed")
                }
                blueprints.push(plan.blueprint.clone());
                base.insert("nextId".to_owned(), Value::from(plan.next_id_after));
                Ok(())
            }
            Some(BlueprintPrivateMutation::Import(plan)) => {
                ensure_private_blueprint_allocator_available(state, base, &plan.blueprint)?;
                let current_next_id = base
                    .get("nextId")
                    .and_then(Value::as_u64)
                    .filter(|value| *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
                    .ok_or_else(|| {
                        anyhow!("native player-authority blueprint next ID is invalid")
                    })?;
                if current_next_id != plan.expected_next_id {
                    bail!("native player-authority blueprint import allocator changed")
                }
                let blueprints = base
                    .get_mut("blueprints")
                    .and_then(Value::as_array_mut)
                    .ok_or_else(|| {
                        anyhow!("native player-authority blueprint directory is invalid")
                    })?;
                if blueprints.len() != plan.expected_library_len {
                    bail!("native player-authority blueprint import library changed")
                }
                blueprints.push(plan.blueprint.clone());
                base.insert("nextId".to_owned(), Value::from(plan.next_id_after));
                Ok(())
            }
        }
    }
}

fn ensure_private_blueprint_allocator_available(
    state: &CoreState,
    base: &Map<String, Value>,
    blueprint: &Value,
) -> anyhow::Result<()> {
    let blueprint_id = blueprint
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("native player-authority blueprint ID is invalid"))?;
    let blueprint_values = base
        .get("blueprints")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("native player-authority blueprint directory is invalid"))?;
    let version_values: &[Value] = match base.get("blueprintVersions") {
        None | Some(Value::Null) => &[],
        Some(Value::Array(values)) => values.as_slice(),
        _ => bail!("native player-authority blueprint versions are invalid"),
    };
    let queue_values = base
        .get("constructionQueue")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("native player-authority construction queue is invalid"))?;
    let blueprints = validate_blueprint_directory(blueprint_values)?;
    let versions = validate_version_directory(version_values)?;
    let queue = validate_queue_directory(queue_values)?;
    if !blueprint_allocator_available(state, &blueprints, &versions, &queue, blueprint_id) {
        bail!("native player-authority blueprint allocator is no longer available")
    }
    Ok(())
}

fn path_matches(path: &[PathSegment], expected: &[&str]) -> bool {
    path.len() == expected.len()
        && path.iter().zip(expected).all(
            |(segment, expected)| matches!(segment, PathSegment::Key(value) if value == expected),
        )
}

fn valid_opaque_text(value: &str, maximum_bytes: usize) -> bool {
    !value.is_empty() && value.len() <= maximum_bytes && !value.chars().any(char::is_control)
}

fn blueprint_edge_whitespace(value: char) -> bool {
    value.is_whitespace() || value == '\u{feff}'
}

fn canonical_blueprint_name(value: &str) -> Option<String> {
    let trimmed = value.trim_matches(blueprint_edge_whitespace);
    if trimmed.is_empty() || trimmed.chars().any(char::is_control) {
        return None;
    }
    let mut units = 0usize;
    let mut canonical = String::new();
    for character in trimmed.chars() {
        let next = units.checked_add(character.len_utf16())?;
        if next > MAX_RENAME_UTF16_UNITS {
            break;
        }
        units = next;
        canonical.push(character);
    }
    let canonical = canonical
        .trim_end_matches(blueprint_edge_whitespace)
        .to_owned();
    (!canonical.is_empty() && !canonical.chars().any(char::is_control)).then_some(canonical)
}

fn validate_capture_entity_ids(entity_ids: Vec<String>) -> anyhow::Result<Vec<String>> {
    if entity_ids.is_empty() || entity_ids.len() > MAX_CAPTURE_ENTITIES {
        bail!("native player-authority blueprint capture entity IDs are invalid")
    }
    let mut unique = HashSet::with_capacity(entity_ids.len());
    if entity_ids
        .iter()
        .any(|id| !valid_opaque_text(id, MAX_OPAQUE_ID_BYTES) || !unique.insert(id.as_str()))
    {
        bail!("native player-authority blueprint capture entity IDs are invalid")
    }
    drop(unique);
    Ok(entity_ids)
}

pub(crate) fn command_contains_intent(command: &SimulationCommandPatch) -> bool {
    command
        .top_level_changes
        .iter()
        .any(|change| path_matches(&change.path, &["blueprints", "intent"]))
}

fn require_intent(command: &SimulationCommandPatch) -> anyhow::Result<BlueprintIntent> {
    if command.top_level_changes.len() != 1
        || !command.changed_entities.is_empty()
        || !command.added_entities.is_empty()
        || !command.removed_entity_ids.is_empty()
        || !command.changed_belts.is_empty()
        || !command.added_belts.is_empty()
        || !command.removed_belt_ids.is_empty()
    {
        bail!("native player-authority blueprint intent shape is invalid")
    }
    let change = &command.top_level_changes[0];
    if !path_matches(&change.path, &["blueprints", "intent"]) || change.operation != "set" {
        bail!("native player-authority blueprint intent path is invalid")
    }
    let intent = change
        .value
        .as_ref()
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native player-authority blueprint intent is invalid"))?;
    let kind = intent
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("native player-authority blueprint intent kind is invalid"))?;
    let existing_id = || {
        intent
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| valid_opaque_text(id, MAX_OPAQUE_ID_BYTES))
            .ok_or_else(|| anyhow!("native player-authority blueprint intent ID is invalid"))
    };
    match kind {
        "rename" => {
            if intent.len() != 3 || !intent.contains_key("name") {
                bail!("native player-authority blueprint rename intent is invalid")
            }
            let name = intent.get("name").and_then(Value::as_str).ok_or_else(|| {
                anyhow!("native player-authority blueprint rename name is invalid")
            })?;
            let canonical = canonical_blueprint_name(name)
                .filter(|canonical| canonical == name)
                .ok_or_else(|| {
                    anyhow!("native player-authority blueprint rename name is not canonical")
                })?;
            let id = existing_id()?;
            Ok(BlueprintIntent::Rename(BlueprintRenameIntent {
                id: id.to_owned(),
                name: canonical,
            }))
        }
        "transform" => {
            if intent.len() != 4
                || !intent.contains_key("rotation")
                || !intent.contains_key("mirror")
            {
                bail!("native player-authority blueprint transform intent is invalid")
            }
            let rotation = intent
                .get("rotation")
                .and_then(Value::as_u64)
                .filter(|rotation| matches!(rotation, 0 | 90 | 180 | 270))
                .ok_or_else(|| {
                    anyhow!("native player-authority blueprint transform rotation is invalid")
                })?;
            let mirror = intent
                .get("mirror")
                .and_then(Value::as_str)
                .filter(|mirror| matches!(*mirror, "none" | "horizontal"))
                .ok_or_else(|| {
                    anyhow!("native player-authority blueprint transform mirror is invalid")
                })?;
            let id = existing_id()?;
            Ok(BlueprintIntent::Transform(BlueprintTransformIntent {
                id: id.to_owned(),
                rotation,
                mirror: mirror.to_owned(),
            }))
        }
        "recipe-override" => {
            if intent.len() != 4
                || !intent.contains_key("sourceRecipeId")
                || !intent.contains_key("targetRecipeId")
            {
                bail!("native player-authority blueprint recipe override intent is invalid")
            }
            let source_recipe_id = intent
                .get("sourceRecipeId")
                .and_then(Value::as_str)
                .filter(|recipe_id| valid_opaque_text(recipe_id, MAX_OPAQUE_ID_BYTES))
                .ok_or_else(|| {
                    anyhow!("native player-authority blueprint source recipe ID is invalid")
                })?;
            let target_recipe_id = intent
                .get("targetRecipeId")
                .and_then(Value::as_str)
                .filter(|recipe_id| valid_opaque_text(recipe_id, MAX_OPAQUE_ID_BYTES))
                .ok_or_else(|| {
                    anyhow!("native player-authority blueprint target recipe ID is invalid")
                })?;
            let id = existing_id()?;
            Ok(BlueprintIntent::RecipeOverride(
                BlueprintRecipeOverrideIntent {
                    id: id.to_owned(),
                    source_recipe_id: source_recipe_id.to_owned(),
                    target_recipe_id: target_recipe_id.to_owned(),
                },
            ))
        }
        "delete" => {
            if intent.len() != 3 || !intent.contains_key("revision") {
                bail!("native player-authority blueprint delete intent is invalid")
            }
            let revision = intent
                .get("revision")
                .and_then(Value::as_u64)
                .filter(|revision| *revision > 0 && *revision <= MAX_JAVASCRIPT_SAFE_INTEGER)
                .ok_or_else(|| {
                    anyhow!("native player-authority blueprint delete revision is invalid")
                })?;
            let id = existing_id()?;
            Ok(BlueprintIntent::Delete(BlueprintDeleteIntent {
                id: id.to_owned(),
                revision,
            }))
        }
        "capture" => {
            if intent.len() != 3
                || !intent.contains_key("entityIds")
                || !intent.contains_key("revision")
            {
                bail!("native player-authority blueprint capture intent is invalid")
            }
            let entity_ids = intent
                .get("entityIds")
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    anyhow!("native player-authority blueprint capture entity IDs are invalid")
                })?;
            let entity_ids = entity_ids
                .iter()
                .map(|value| {
                    value.as_str().map(str::to_owned).ok_or_else(|| {
                        anyhow!("native player-authority blueprint capture entity IDs are invalid")
                    })
                })
                .collect::<anyhow::Result<Vec<_>>>()?;
            let entity_ids = validate_capture_entity_ids(entity_ids)?;
            let revision = intent
                .get("revision")
                .and_then(Value::as_u64)
                .filter(|revision| *revision < MAX_JAVASCRIPT_SAFE_INTEGER)
                .ok_or_else(|| {
                    anyhow!("native player-authority blueprint capture revision is invalid")
                })?;
            Ok(BlueprintIntent::Capture(BlueprintCaptureIntent {
                entity_ids,
                revision,
            }))
        }
        "import" => {
            if serde_json::to_vec(command)?.len() > MAX_BLUEPRINT_IMPORT_COMMAND_BYTES {
                bail!("native player-authority blueprint import command exceeds the byte limit")
            }
            Ok(BlueprintIntent::Import(parse_import_marker(intent)?))
        }
        _ => bail!("native player-authority blueprint intent kind is invalid"),
    }
}

fn optional_array_shape(row: &Map<String, Value>, key: &str, label: &str) -> anyhow::Result<()> {
    match row.get(key) {
        None | Some(Value::Null) | Some(Value::Array(_)) => Ok(()),
        _ => bail!("native player-authority blueprint {label} is invalid"),
    }
}

fn recipe_override_shape(row: &Map<String, Value>) -> anyhow::Result<()> {
    match row.get("recipeOverrides") {
        None | Some(Value::Null) => Ok(()),
        Some(Value::Object(overrides)) => {
            if overrides.len() > MAX_RECIPE_OVERRIDE_ROWS {
                bail!("native player-authority blueprint recipe override source limit is exceeded")
            }
            for (source_recipe_id, target_recipe_id) in overrides {
                if !valid_opaque_text(source_recipe_id, MAX_OPAQUE_ID_BYTES)
                    || !target_recipe_id
                        .as_str()
                        .is_some_and(|value| valid_opaque_text(value, MAX_OPAQUE_ID_BYTES))
                {
                    bail!("native player-authority blueprint recipe overrides are invalid")
                }
            }
            Ok(())
        }
        _ => bail!("native player-authority blueprint recipe overrides are invalid"),
    }
}

fn blueprint_revision(row: &Map<String, Value>) -> anyhow::Result<u64> {
    match row.get("revision") {
        None | Some(Value::Null) => Ok(1),
        Some(value) => value
            .as_u64()
            .filter(|revision| *revision > 0 && *revision <= MAX_JAVASCRIPT_SAFE_INTEGER)
            .ok_or_else(|| anyhow!("native player-authority blueprint revision is invalid")),
    }
}

fn validate_blueprint_row(
    row: &Map<String, Value>,
) -> anyhow::Result<(&str, &str, u64, u64, &str)> {
    let id = row
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| valid_opaque_text(id, MAX_OPAQUE_ID_BYTES))
        .ok_or_else(|| anyhow!("native player-authority blueprint ID is invalid"))?;
    let name = row
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| valid_opaque_text(name, MAX_EXISTING_NAME_BYTES))
        .ok_or_else(|| anyhow!("native player-authority blueprint name is invalid"))?;
    row.get("entities")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("native player-authority blueprint entities are invalid"))?;
    row.get("belts")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("native player-authority blueprint belts are invalid"))?;
    optional_array_shape(row, "resourceAnchors", "resource anchors")?;
    optional_array_shape(row, "externalPorts", "external ports")?;
    recipe_override_shape(row)?;
    let rotation = match row.get("rotation") {
        None | Some(Value::Null) => 0,
        Some(value)
            if value
                .as_u64()
                .is_some_and(|rotation| matches!(rotation, 0 | 90 | 180 | 270)) =>
        {
            value.as_u64().expect("validated u64 rotation")
        }
        _ => bail!("native player-authority blueprint rotation is invalid"),
    };
    let mirror = match row.get("mirror") {
        None | Some(Value::Null) => "none",
        Some(Value::String(value)) if matches!(value.as_str(), "none" | "horizontal") => {
            value.as_str()
        }
        _ => bail!("native player-authority blueprint mirror is invalid"),
    };
    Ok((id, name, blueprint_revision(row)?, rotation, mirror))
}

fn required_capture_text<'a>(
    row: &'a Map<String, Value>,
    key: &str,
    label: &str,
) -> anyhow::Result<&'a str> {
    row.get(key)
        .and_then(Value::as_str)
        .filter(|value| valid_opaque_text(value, MAX_OPAQUE_ID_BYTES))
        .ok_or_else(|| anyhow!("native blueprint capture {label} is invalid"))
}

fn finite_capture_number(value: Option<&Value>, label: &str) -> anyhow::Result<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .ok_or_else(|| anyhow!("native blueprint capture {label} is invalid"))
}

fn exact_capture_stack(value: Option<&Value>) -> anyhow::Result<u64> {
    value
        .and_then(Value::as_u64)
        .filter(|value| (1..=MAX_BUILDING_STACK_COUNT).contains(value))
        .ok_or_else(|| anyhow!("native blueprint capture machine count is invalid"))
}

fn copy_present_fields(
    source: &Map<String, Value>,
    target: &mut Map<String, Value>,
    keys: &[&str],
) {
    for key in keys {
        if let Some(value) = source.get(*key) {
            target.insert((*key).to_owned(), value.clone());
        }
    }
}

fn active_capture_planet_id(state: &CoreState) -> anyhow::Result<&str> {
    let active_planet_id = state
        .base_value()
        .get("activePlanetId")
        .and_then(Value::as_str)
        .filter(|value| valid_opaque_text(value, MAX_OPAQUE_ID_BYTES))
        .ok_or_else(|| anyhow!("native blueprint capture active planet is invalid"))?;
    if !state
        .catalog
        .planets
        .iter()
        .any(|planet| planet.id == active_planet_id)
    {
        bail!("native blueprint capture active planet is missing from the catalog")
    }
    Ok(active_planet_id)
}

fn prepare_capture(
    state: &CoreState,
    intent: &BlueprintCaptureIntent,
) -> anyhow::Result<BlueprintCapturePreparation> {
    let base = state.base_value();
    let blueprint_values = base
        .get("blueprints")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("native blueprint capture library is invalid"))?;
    let blueprints = validate_blueprint_directory(blueprint_values)?;
    let empty_version_values = Vec::new();
    let version_values = match base.get("blueprintVersions") {
        None | Some(Value::Null) => &empty_version_values,
        Some(Value::Array(values)) => values,
        _ => bail!("native blueprint capture version directory is invalid"),
    };
    let queue_values = base
        .get("constructionQueue")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("native blueprint capture queue directory is invalid"))?;
    let versions = validate_version_directory(version_values)?;
    let queue = validate_queue_directory(queue_values)?;
    let mut strict_ids = HashSet::with_capacity(blueprints.len());
    for row in &blueprints {
        let (id, _, _, _, _) = validate_blueprint_row(row)?;
        if !strict_ids.insert(id) {
            bail!("native blueprint capture library IDs are not unique")
        }
    }
    if blueprints.len() >= MAX_BLUEPRINT_ROWS {
        return Ok(BlueprintCapturePreparation::Unsupported("library-full"));
    }

    let active_planet_id = active_capture_planet_id(state)?.to_owned();
    let active_planet = state
        .catalog
        .planets
        .iter()
        .find(|planet| planet.id == active_planet_id)
        .expect("active capture planet membership was validated");
    if active_planet.kind != "terrestrial" {
        return Ok(BlueprintCapturePreparation::Unsupported(
            "unsupported-active-planet",
        ));
    }
    if state.identity.registry_fingerprint != state.catalog.snapshot.registry_fingerprint
        || !state.catalog.data_only_native_supported
    {
        return Ok(BlueprintCapturePreparation::Unsupported(
            "unsupported-blueprint-domain",
        ));
    }

    let mut selected = Vec::with_capacity(intent.entity_ids.len());
    for entity_id in &intent.entity_ids {
        let Some(index) = state.entity_index.get(entity_id).copied() else {
            return Ok(BlueprintCapturePreparation::Unsupported(
                "selection-conflict",
            ));
        };
        selected.push((index, entity_id.clone()));
    }
    selected.sort_unstable_by_key(|(index, _)| *index);

    const ENTITY_CONFIG_KEYS: &[&str] = &[
        "recipeId",
        "storedItemId",
        "distributionMode",
        "fuelItemId",
        "energyMode",
        "powerGridId",
        "powerPriority",
        "generationPriority",
        "sprayCoaterInstalled",
        "proliferatorTier",
        "proliferatorMode",
    ];
    let mut pending_entities = Vec::with_capacity(selected.len());
    let mut key_by_id = HashMap::with_capacity(selected.len());
    let mut origin_x = f64::INFINITY;
    let mut origin_y = f64::INFINITY;
    for (ordinal, (index, requested_id)) in selected.iter().enumerate() {
        let entity = state.parse_entity(*index)?;
        let entity = entity
            .as_object()
            .ok_or_else(|| anyhow!("native blueprint capture entity is invalid"))?;
        if required_capture_text(entity, "id", "entity ID")? != requested_id {
            bail!("native blueprint capture entity index is inconsistent")
        }
        if entity.get("planetId").and_then(Value::as_str) != Some(&active_planet_id) {
            return Ok(BlueprintCapturePreparation::Unsupported(
                "selection-conflict",
            ));
        }
        if entity.get("kind").and_then(Value::as_str) == Some("vein") {
            return Ok(BlueprintCapturePreparation::Unsupported(
                "unsupported-blueprint-domain",
            ));
        }
        let building_id = required_capture_text(entity, "buildingId", "building ID")?;
        if !crate::command::ordinary_placement_building_domain_supported(building_id) {
            return Ok(BlueprintCapturePreparation::Unsupported(
                "unsupported-blueprint-domain",
            ));
        }
        let Some(building) = state.catalog.buildings.get(building_id) else {
            return Ok(BlueprintCapturePreparation::Unsupported(
                "catalog-incomplete",
            ));
        };
        let expected_kind = match building.kind.as_str() {
            "machine" => "machine",
            "power" => "power",
            "storage" => "storage",
            "splitter" => "splitter",
            _ => {
                return Ok(BlueprintCapturePreparation::Unsupported(
                    "unsupported-blueprint-domain",
                ));
            }
        };
        if entity.get("kind").and_then(Value::as_str) != Some(expected_kind) {
            bail!("native blueprint capture entity kind is inconsistent")
        }
        if let Some(reason) = crate::command::ordinary_placement_support_reason_on_planet(
            state,
            building_id,
            &active_planet_id,
        )? {
            return Ok(BlueprintCapturePreparation::Unsupported(match reason {
                crate::command::OrdinaryPlacementUnsupportedReason::UnknownBuilding
                | crate::command::OrdinaryPlacementUnsupportedReason::MissingConstructionDefinition
                | crate::command::OrdinaryPlacementUnsupportedReason::TechnologyLocked => {
                    "catalog-incomplete"
                }
                crate::command::OrdinaryPlacementUnsupportedReason::UnsupportedBuildingKind
                | crate::command::OrdinaryPlacementUnsupportedReason::UnsupportedBuildingDomain => {
                    "unsupported-blueprint-domain"
                }
                crate::command::OrdinaryPlacementUnsupportedReason::UnsupportedActivePlanet => {
                    "unsupported-active-planet"
                }
            }));
        }
        let position = entity
            .get("position")
            .and_then(Value::as_object)
            .ok_or_else(|| anyhow!("native blueprint capture entity position is invalid"))?;
        let x = finite_capture_number(position.get("x"), "entity x position")?;
        let y = finite_capture_number(position.get("y"), "entity y position")?;
        origin_x = origin_x.min(x);
        origin_y = origin_y.min(y);
        let key = format!("node_{}", ordinal + 1);
        key_by_id.insert(requested_id.clone(), key.clone());
        let mut template = Map::new();
        template.insert("key".to_owned(), Value::from(key));
        template.insert("buildingId".to_owned(), Value::from(building_id));
        template.insert(
            "machineCount".to_owned(),
            Value::from(exact_capture_stack(entity.get("machineCount"))?),
        );
        copy_present_fields(entity, &mut template, ENTITY_CONFIG_KEYS);
        if building_id == "em_rail_ejector"
            && let Some(value) = entity.get("targetDysonOrbitId")
        {
            template.insert("targetDysonOrbitId".to_owned(), value.clone());
        }
        pending_entities.push((template, x, y));
    }

    let entity_templates = pending_entities
        .into_iter()
        .map(|(mut template, x, y)| {
            template.insert(
                "offset".to_owned(),
                json!({ "x": x - origin_x, "y": y - origin_y }),
            );
            Value::Object(template)
        })
        .collect::<Vec<_>>();

    const BELT_CONFIG_KEYS: &[&str] = &[
        "sorterTier",
        "priority",
        "stackSize",
        "monitorEnabled",
        "routeOffsetY",
    ];
    let mut belt_templates = Vec::new();
    for index in 0..state.belt_index.len() {
        let belt = state.parse_belt(index)?;
        let belt = belt
            .as_object()
            .ok_or_else(|| anyhow!("native blueprint capture belt is invalid"))?;
        let source = required_capture_text(belt, "source", "belt source")?;
        let target = required_capture_text(belt, "target", "belt target")?;
        let source_selected = key_by_id.contains_key(source);
        let target_selected = key_by_id.contains_key(target);
        if source_selected != target_selected {
            return Ok(BlueprintCapturePreparation::Unsupported(
                "unsupported-blueprint-domain",
            ));
        }
        if !source_selected {
            continue;
        }
        if belt_templates.len() >= MAX_CAPTURE_BELTS {
            return Ok(BlueprintCapturePreparation::Unsupported(
                "unsupported-blueprint-domain",
            ));
        }
        if belt.get("planetId").and_then(Value::as_str) != Some(&active_planet_id) {
            bail!("native blueprint capture belt planet is inconsistent")
        }
        if belt
            .get("targetPortIndex")
            .is_some_and(|value| !value.is_null())
            || belt
                .get("elevatorOutputIndex")
                .is_some_and(|value| !value.is_null())
        {
            return Ok(BlueprintCapturePreparation::Unsupported(
                "unsupported-blueprint-domain",
            ));
        }
        let item_id = required_capture_text(belt, "itemId", "belt item ID")?;
        if !state.catalog.items.contains_key(item_id) {
            return Ok(BlueprintCapturePreparation::Unsupported(
                "catalog-incomplete",
            ));
        }
        let source_key = key_by_id
            .get(source)
            .ok_or_else(|| anyhow!("native blueprint capture source key is missing"))?;
        let target_key = key_by_id
            .get(target)
            .ok_or_else(|| anyhow!("native blueprint capture target key is missing"))?;
        let mut template = Map::new();
        template.insert(
            "key".to_owned(),
            Value::from(format!("line_{}", belt_templates.len() + 1)),
        );
        template.insert("sourceKey".to_owned(), Value::from(source_key.clone()));
        template.insert("targetKey".to_owned(), Value::from(target_key.clone()));
        template.insert("itemId".to_owned(), Value::from(item_id));
        template.insert(
            "lanes".to_owned(),
            belt.get("lanes")
                .cloned()
                .ok_or_else(|| anyhow!("native blueprint capture belt lanes are invalid"))?,
        );
        template.insert(
            "tier".to_owned(),
            belt.get("tier")
                .cloned()
                .ok_or_else(|| anyhow!("native blueprint capture belt tier is invalid"))?,
        );
        copy_present_fields(belt, &mut template, BELT_CONFIG_KEYS);
        template.insert(
            "routeMode".to_owned(),
            match belt.get("routeMode") {
                None | Some(Value::Null) => Value::from("auto"),
                Some(value) => value.clone(),
            },
        );
        belt_templates.push(Value::Object(template));
    }

    let next_id = base
        .get("nextId")
        .and_then(Value::as_u64)
        .filter(|value| *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
        .ok_or_else(|| anyhow!("native blueprint capture next ID is invalid"))?;
    let Some(next_id_after) = next_id.checked_add(1) else {
        return Ok(BlueprintCapturePreparation::Unsupported(
            "next-id-exhausted",
        ));
    };
    if next_id_after > MAX_JAVASCRIPT_SAFE_INTEGER {
        return Ok(BlueprintCapturePreparation::Unsupported(
            "next-id-exhausted",
        ));
    }
    let blueprint_id = format!("blueprint_{next_id}");
    if !blueprint_allocator_available(state, &blueprints, &versions, &queue, &blueprint_id) {
        return Ok(BlueprintCapturePreparation::Unsupported(
            "next-id-exhausted",
        ));
    }
    let blueprint_name = format!("蓝图 {:02}", blueprints.len() + 1);
    let blueprint = json!({
        "id": blueprint_id,
        "name": blueprint_name,
        "revision": 1,
        "entities": entity_templates,
        "resourceAnchors": [],
        "belts": belt_templates,
        "externalPorts": [],
        "rotation": 0,
        "mirror": "none",
        "recipeOverrides": {},
    });
    let blueprint = blueprint
        .as_object()
        .expect("native capture blueprint literal is an object");
    if !ordinary_blueprint_definition_supported_on_planet(state, blueprint, &active_planet_id)? {
        return Ok(BlueprintCapturePreparation::Unsupported(
            "catalog-incomplete",
        ));
    }
    if !ordinary_blueprint_definition_has_no_internal_overlap(blueprint)? {
        return Ok(BlueprintCapturePreparation::Unsupported("position-overlap"));
    }
    Ok(BlueprintCapturePreparation::Supported(
        BlueprintCapturePlan {
            expected_next_id: next_id,
            expected_library_len: blueprints.len(),
            blueprint: Value::Object(blueprint.clone()),
            next_id_after,
        },
    ))
}

fn validated_intent(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<ValidatedBlueprintIntent> {
    let intent = require_intent(command)?;
    if let BlueprintIntent::Capture(capture) = &intent {
        if capture.revision != command.base_revision || command.base_revision != state.revision {
            bail!("native player-authority blueprint capture revision is not current")
        }
        return match prepare_capture(state, capture)? {
            BlueprintCapturePreparation::Supported(plan) => {
                Ok(ValidatedBlueprintIntent::Capture(plan))
            }
            BlueprintCapturePreparation::Unsupported(reason) => {
                bail!("native blueprint capture is unsupported: {reason}")
            }
        };
    }
    if let BlueprintIntent::Import(import) = &intent {
        if import.revision != command.base_revision || command.base_revision != state.revision {
            bail!("native player-authority blueprint import revision is not current")
        }
        return match prepare_import_marker(state, import)? {
            BlueprintImportPreparation::Supported { plan, .. } => {
                Ok(ValidatedBlueprintIntent::Import(plan))
            }
            BlueprintImportPreparation::Unsupported(reason) => {
                bail!("native blueprint import is unsupported: {reason}")
            }
        };
    }
    let blueprints = state
        .base_value()
        .get("blueprints")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("native player-authority blueprint directory is invalid"))?;
    if blueprints.len() > MAX_BLUEPRINT_ROWS {
        bail!("native player-authority blueprint directory source limit is exceeded")
    }
    let mut ids = HashSet::with_capacity(blueprints.len());
    let mut target = None;
    for (index, value) in blueprints.iter().enumerate() {
        let row = value
            .as_object()
            .ok_or_else(|| anyhow!("native player-authority blueprint row is invalid"))?;
        let (id, current_name, revision, current_rotation, current_mirror) =
            validate_blueprint_row(row)?;
        if !ids.insert(id) {
            bail!("native player-authority blueprint IDs are not unique")
        }
        let target_id = match &intent {
            BlueprintIntent::Rename(intent) => intent.id.as_str(),
            BlueprintIntent::Transform(intent) => intent.id.as_str(),
            BlueprintIntent::RecipeOverride(intent) => intent.id.as_str(),
            BlueprintIntent::Delete(intent) => intent.id.as_str(),
            BlueprintIntent::Capture(_) => unreachable!("capture returned before target lookup"),
            BlueprintIntent::Import(_) => unreachable!("import returned before target lookup"),
        };
        if id == target_id {
            if target.is_some() {
                bail!("native player-authority blueprint target is not unique")
            }
            target = Some(match &intent {
                BlueprintIntent::Rename(intent) => {
                    if current_name == intent.name {
                        bail!("native player-authority blueprint rename target is unchanged")
                    }
                    let next_revision = revision
                        .checked_add(1)
                        .filter(|value| *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
                        .ok_or_else(|| {
                            anyhow!("native player-authority blueprint revision overflows")
                        })?;
                    ValidatedBlueprintIntent::Rename(ValidatedBlueprintRename {
                        index,
                        name: intent.name.clone(),
                        revision: next_revision,
                    })
                }
                BlueprintIntent::Transform(intent) => {
                    if current_rotation == intent.rotation && current_mirror == intent.mirror {
                        bail!("native player-authority blueprint transform target is unchanged")
                    }
                    let next_revision = revision
                        .checked_add(1)
                        .filter(|value| *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
                        .ok_or_else(|| {
                            anyhow!("native player-authority blueprint revision overflows")
                        })?;
                    ValidatedBlueprintIntent::Transform(ValidatedBlueprintTransform {
                        index,
                        rotation: intent.rotation,
                        mirror: intent.mirror.clone(),
                        revision: next_revision,
                    })
                }
                BlueprintIntent::RecipeOverride(intent) => {
                    let entities = row
                        .get("entities")
                        .and_then(Value::as_array)
                        .expect("blueprint row entities were validated above");
                    let source_recipe = state
                        .catalog
                        .recipes
                        .get(&intent.source_recipe_id)
                        .ok_or_else(|| {
                            anyhow!(
                                "native player-authority blueprint source recipe is not in the catalog"
                            )
                        })?;
                    if let Some(technology_id) = source_recipe.required_tech_id.as_deref()
                        && (!state.catalog.technologies.contains_key(technology_id)
                            || !crate::command::technology_is_completed(state, technology_id))
                    {
                        bail!(
                            "native player-authority blueprint source recipe technology is locked or missing"
                        )
                    }
                    let target_recipe = state
                        .catalog
                        .recipes
                        .get(&intent.target_recipe_id)
                        .ok_or_else(|| {
                            anyhow!(
                                "native player-authority blueprint target recipe is not in the catalog"
                            )
                        })?;
                    if let Some(technology_id) = target_recipe.required_tech_id.as_deref()
                        && (!state.catalog.technologies.contains_key(technology_id)
                            || !crate::command::technology_is_completed(state, technology_id))
                    {
                        bail!(
                            "native player-authority blueprint target recipe technology is locked or missing"
                        )
                    }
                    let mut matching_templates = 0usize;
                    for template in entities {
                        let template = template.as_object().ok_or_else(|| {
                            anyhow!("native player-authority blueprint entity template is invalid")
                        })?;
                        let recipe_id = match template.get("recipeId") {
                            None | Some(Value::Null) => None,
                            Some(Value::String(recipe_id)) => Some(recipe_id.as_str()),
                            _ => {
                                bail!(
                                    "native player-authority blueprint entity recipe ID is invalid"
                                )
                            }
                        };
                        if recipe_id != Some(intent.source_recipe_id.as_str()) {
                            continue;
                        }
                        matching_templates = matching_templates.checked_add(1).ok_or_else(|| {
                            anyhow!(
                                "native player-authority blueprint matching template count overflows"
                            )
                        })?;
                        let building_id = template
                            .get("buildingId")
                            .and_then(Value::as_str)
                            .filter(|building_id| valid_opaque_text(building_id, MAX_OPAQUE_ID_BYTES))
                            .ok_or_else(|| {
                                anyhow!(
                                    "native player-authority blueprint matching template building ID is invalid"
                                )
                            })?;
                        let building = state.catalog.buildings.get(building_id).ok_or_else(|| {
                            anyhow!(
                                "native player-authority blueprint matching template building is not in the catalog"
                            )
                        })?;
                        let building_base_id = crate::command::recipe_building_base(
                            building_id,
                            building.family.as_deref(),
                        );
                        if building_base_id != source_recipe.building_id
                            || building_base_id != target_recipe.building_id
                        {
                            bail!(
                                "native player-authority blueprint source or target recipe is incompatible with a matching template"
                            )
                        }
                    }
                    if matching_templates == 0 {
                        bail!(
                            "native player-authority blueprint source recipe has no matching templates"
                        )
                    }
                    // `recipeOverrides` is optional in public v47. Existing
                    // maps stay one-key leaf mutations; the first non-default
                    // override atomically creates a one-entry map.
                    let (overrides, create_map) = match row.get("recipeOverrides") {
                        None | Some(Value::Null) => (None, true),
                        Some(Value::Object(overrides)) => (Some(overrides), false),
                        Some(_) => unreachable!("blueprint override shape was validated above"),
                    };
                    let current_override =
                        overrides.and_then(|values| values.get(&intent.source_recipe_id));
                    let delete = intent.source_recipe_id == intent.target_recipe_id;
                    if !delete
                        && current_override.is_none()
                        && overrides.is_some_and(|values| values.len() >= MAX_RECIPE_OVERRIDE_ROWS)
                    {
                        bail!(
                            "native player-authority blueprint recipe override source limit is exceeded"
                        )
                    }
                    if delete {
                        if current_override.is_none() {
                            bail!(
                                "native player-authority blueprint recipe override target is unchanged"
                            )
                        }
                    } else if current_override.and_then(Value::as_str)
                        == Some(intent.target_recipe_id.as_str())
                    {
                        bail!(
                            "native player-authority blueprint recipe override target is unchanged"
                        )
                    }
                    let next_revision = revision
                        .checked_add(1)
                        .filter(|value| *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
                        .ok_or_else(|| {
                            anyhow!("native player-authority blueprint revision overflows")
                        })?;
                    ValidatedBlueprintIntent::RecipeOverride(ValidatedBlueprintRecipeOverride {
                        index,
                        source_recipe_id: intent.source_recipe_id.clone(),
                        target_recipe_id: intent.target_recipe_id.clone(),
                        delete,
                        create_map,
                        revision: next_revision,
                    })
                }
                BlueprintIntent::Delete(intent) => {
                    if revision != intent.revision {
                        bail!("native player-authority blueprint delete revision is not current")
                    }
                    ValidatedBlueprintIntent::Delete(ValidatedBlueprintDelete { index })
                }
                BlueprintIntent::Capture(_) => {
                    unreachable!("capture returned before target validation")
                }
                BlueprintIntent::Import(_) => {
                    unreachable!("import returned before target validation")
                }
            });
        }
    }
    target.ok_or_else(|| anyhow!("native player-authority blueprint target is missing"))
}

pub(crate) fn validate_command(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<()> {
    validated_intent(state, command).map(|_| ())
}

pub(crate) fn validate_resume_marker(command: &SimulationCommandPatch) -> anyhow::Result<()> {
    require_intent(command).map(|_| ())
}

pub(crate) fn expand_intent(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<BlueprintCommandExpansion> {
    let intent = validated_intent(state, command)?;
    let (top_level_changes, mutation) = match intent {
        ValidatedBlueprintIntent::Rename(rename) => (
            vec![
                ValuePatch {
                    path: vec![
                        PathSegment::Key("blueprints".to_owned()),
                        PathSegment::Index(rename.index),
                        PathSegment::Key("name".to_owned()),
                    ],
                    operation: "set".to_owned(),
                    value: Some(Value::from(rename.name)),
                },
                ValuePatch {
                    path: vec![
                        PathSegment::Key("blueprints".to_owned()),
                        PathSegment::Index(rename.index),
                        PathSegment::Key("revision".to_owned()),
                    ],
                    operation: "set".to_owned(),
                    value: Some(Value::from(rename.revision)),
                },
            ],
            None,
        ),
        ValidatedBlueprintIntent::Transform(transform) => (
            vec![
                ValuePatch {
                    path: vec![
                        PathSegment::Key("blueprints".to_owned()),
                        PathSegment::Index(transform.index),
                        PathSegment::Key("rotation".to_owned()),
                    ],
                    operation: "set".to_owned(),
                    value: Some(Value::from(transform.rotation)),
                },
                ValuePatch {
                    path: vec![
                        PathSegment::Key("blueprints".to_owned()),
                        PathSegment::Index(transform.index),
                        PathSegment::Key("mirror".to_owned()),
                    ],
                    operation: "set".to_owned(),
                    value: Some(Value::from(transform.mirror)),
                },
                ValuePatch {
                    path: vec![
                        PathSegment::Key("blueprints".to_owned()),
                        PathSegment::Index(transform.index),
                        PathSegment::Key("revision".to_owned()),
                    ],
                    operation: "set".to_owned(),
                    value: Some(Value::from(transform.revision)),
                },
            ],
            None,
        ),
        ValidatedBlueprintIntent::RecipeOverride(override_intent) => {
            let path_prefix = vec![
                PathSegment::Key("blueprints".to_owned()),
                PathSegment::Index(override_intent.index),
            ];
            let mut override_path = path_prefix.clone();
            override_path.push(PathSegment::Key("recipeOverrides".to_owned()));
            if !override_intent.create_map {
                override_path.push(PathSegment::Key(override_intent.source_recipe_id.clone()));
            }
            let mut revision_path = path_prefix;
            revision_path.push(PathSegment::Key("revision".to_owned()));
            (
                vec![
                    ValuePatch {
                        path: override_path,
                        operation: if override_intent.delete {
                            "delete".to_owned()
                        } else {
                            "set".to_owned()
                        },
                        value: (!override_intent.delete).then(|| {
                            if override_intent.create_map {
                                json!({
                                    override_intent.source_recipe_id:
                                        override_intent.target_recipe_id
                                })
                            } else {
                                Value::from(override_intent.target_recipe_id)
                            }
                        }),
                    },
                    ValuePatch {
                        path: revision_path,
                        operation: "set".to_owned(),
                        value: Some(Value::from(override_intent.revision)),
                    },
                ],
                None,
            )
        }
        ValidatedBlueprintIntent::Delete(delete) => (
            Vec::new(),
            Some(BlueprintPrivateMutation::Delete {
                index: delete.index,
            }),
        ),
        ValidatedBlueprintIntent::Capture(plan) => {
            (Vec::new(), Some(BlueprintPrivateMutation::Capture(plan)))
        }
        ValidatedBlueprintIntent::Import(plan) => {
            (Vec::new(), Some(BlueprintPrivateMutation::Import(plan)))
        }
    };
    Ok(BlueprintCommandExpansion {
        command: SimulationCommandPatch {
            protocol_version: command.protocol_version,
            base_revision: command.base_revision,
            top_level_changes,
            changed_entities: Vec::new(),
            added_entities: Vec::new(),
            removed_entity_ids: Vec::new(),
            changed_belts: Vec::new(),
            added_belts: Vec::new(),
            removed_belt_ids: Vec::new(),
        },
        mutation,
    })
}

impl CoreState {
    /// Same-revision, bounded authority proof for capturing one closed ordinary
    /// selection. The blueprint body and allocator remain Core-private; the
    /// renderer receives only enough identity to reconcile the durable marker.
    pub fn blueprint_capture_context_projection(
        &self,
        expected_revision: u64,
        expected_registry_fingerprint: &str,
        entity_ids: &[String],
    ) -> anyhow::Result<Value> {
        if expected_revision != self.revision
            || expected_revision >= MAX_JAVASCRIPT_SAFE_INTEGER
            || expected_registry_fingerprint != self.catalog.snapshot.registry_fingerprint
        {
            bail!("native blueprint capture context request is invalid")
        }
        let entity_ids = validate_capture_entity_ids(entity_ids.to_vec())?;
        let active_planet_id = active_capture_planet_id(self)?.to_owned();
        let intent = BlueprintCaptureIntent {
            entity_ids: entity_ids.clone(),
            revision: expected_revision,
        };
        let preparation = prepare_capture(self, &intent)?;
        let (supported, reason, expected_id, expected_name, expected_blueprint_revision) =
            match preparation {
                BlueprintCapturePreparation::Supported(plan) => {
                    let blueprint = plan.blueprint.as_object().ok_or_else(|| {
                        anyhow!("native blueprint capture prepared blueprint is invalid")
                    })?;
                    let id = required_capture_text(blueprint, "id", "prepared blueprint ID")?;
                    let name = required_capture_text(blueprint, "name", "prepared blueprint name")?;
                    (
                        true,
                        Value::Null,
                        Value::from(id),
                        Value::from(name),
                        Value::from(1),
                    )
                }
                BlueprintCapturePreparation::Unsupported(reason) => (
                    false,
                    Value::from(reason),
                    Value::Null,
                    Value::Null,
                    Value::Null,
                ),
            };
        let value = json!({
            "schemaVersion": 1,
            "projectionType": BLUEPRINT_CAPTURE_CONTEXT_PROJECTION,
            "source": "native-core",
            "revision": self.revision,
            "stateVersion": self.identity.state_version,
            "registryFingerprint": self.catalog.snapshot.registry_fingerprint,
            "request": {
                "expectedRevision": expected_revision,
                "expectedRegistryFingerprint": expected_registry_fingerprint,
                "entityIds": entity_ids,
            },
            "activePlanetId": active_planet_id,
            "support": {
                "supported": supported,
                "reason": reason,
            },
            "expectedBlueprintId": expected_id,
            "expectedBlueprintName": expected_name,
            "expectedBlueprintRevision": expected_blueprint_revision,
            "limits": {
                "selectionEntityIds": MAX_CAPTURE_ENTITIES,
                "blueprintEntities": MAX_CAPTURE_ENTITIES,
                "blueprintBelts": MAX_CAPTURE_BELTS,
                "opaqueIdBytes": MAX_OPAQUE_ID_BYTES,
                "projectionBytes": MAX_PROJECTION_BYTES,
            },
        });
        if serde_json::to_vec(&value)?.len() > MAX_PROJECTION_BYTES {
            bail!("native blueprint capture context exceeds the byte limit")
        }
        Ok(value)
    }
}
