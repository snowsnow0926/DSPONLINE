//! Minimal, durable blueprint metadata intents.
//!
//! The renderer sends the exact rename marker `{ kind, id, name }`, the exact
//! target-state transform marker `{ kind, id, rotation, mirror }`, the exact
//! recipe override marker `{ kind, id, sourceRecipeId, targetRecipeId }`, or
//! the exact delete marker `{ kind, id, revision }`.
//! Rust validates the complete public-v47 blueprint directory and expands the
//! marker to an authoritative mutation. Rename and transform use ordinary leaf
//! patches. Delete keeps its validated array index in a private Core-only plan,
//! so the generic patch engine still forbids renderer-accessible array deletion
//! and no complete blueprint directory is copied into the command. No blueprint
//! body, version snapshot, queue, inventory, entity, belt, or allocator field is
//! renderer-derived.

use std::collections::HashSet;

use anyhow::{anyhow, bail};
use serde_json::{Map, Value, json};

use crate::{
    command::{PathSegment, SimulationCommandPatch, ValuePatch},
    state::CoreState,
};

const MAX_BLUEPRINT_ROWS: usize = 4_096;
const MAX_RECIPE_OVERRIDE_ROWS: usize = 4_096;
const MAX_OPAQUE_ID_BYTES: usize = 512;
const MAX_EXISTING_NAME_BYTES: usize = 256;
const MAX_RENAME_UTF16_UNITS: usize = 32;
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
enum BlueprintIntent {
    Rename(BlueprintRenameIntent),
    Transform(BlueprintTransformIntent),
    RecipeOverride(BlueprintRecipeOverrideIntent),
    Delete(BlueprintDeleteIntent),
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
enum ValidatedBlueprintIntent {
    Rename(ValidatedBlueprintRename),
    Transform(ValidatedBlueprintTransform),
    RecipeOverride(ValidatedBlueprintRecipeOverride),
    Delete(ValidatedBlueprintDelete),
}

/// Core-only expansion of a validated semantic blueprint marker.
///
/// `delete_index` is deliberately not serializable and never crosses the Host
/// or WAL boundary. It can only be produced after `validated_intent()` has
/// proved the complete blueprint directory and exact target revision.
pub(crate) struct BlueprintCommandExpansion {
    command: SimulationCommandPatch,
    delete_index: Option<usize>,
}

impl BlueprintCommandExpansion {
    pub(crate) fn command(&self) -> &SimulationCommandPatch {
        &self.command
    }

    pub(crate) fn delete_index(&self) -> Option<usize> {
        self.delete_index
    }
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
    let id = intent
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| valid_opaque_text(id, MAX_OPAQUE_ID_BYTES))
        .ok_or_else(|| anyhow!("native player-authority blueprint intent ID is invalid"))?;
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
            Ok(BlueprintIntent::Delete(BlueprintDeleteIntent {
                id: id.to_owned(),
                revision,
            }))
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

fn validated_intent(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<ValidatedBlueprintIntent> {
    let intent = require_intent(command)?;
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
    let (top_level_changes, delete_index) = match intent {
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
        ValidatedBlueprintIntent::Delete(delete) => (Vec::new(), Some(delete.index)),
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
        delete_index,
    })
}
