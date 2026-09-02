//! Compact semantic commands for the remaining bounded workspace actions.
//!
//! These actions used to be disabled while the Windows native authority owned
//! the save because their Web handlers derived mutations from the renderer's
//! stale `GameState`.  The durable marker carries only the player's intent;
//! Rust re-reads the exact source revision and derives every affected leaf,
//! refund and topology removal before the generic transactional command engine
//! publishes the next revision.

use std::collections::{BTreeMap, BTreeSet, HashSet};

use anyhow::{anyhow, bail};
use serde_json::{Map, Value};

use crate::{
    command::{PathSegment, RecordPatch, SimulationCommandPatch, create_expected_value_patches},
    state::CoreState,
};

const INTENT_ROOT: &str = "workspaceAction";
const INTENT_LEAF: &str = "intent";
const MAX_ID_BYTES: usize = 512;
const MAX_NAME_CHARS: usize = 28;
const MAX_BATCHES: u64 = 1_000_000;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_EXPANDED_CHANGES: usize = 65_536;
const MIN_REGION_SIZE: f64 = 40.0;
const MAX_REGION_SIZE: f64 = 20_000.0;
const MAX_DISPLAY_TEXT_BYTES: usize = 2_048;
const PLANET_NAME_UTF16_UNITS: usize = 32;
const SYSTEM_NAME_UTF16_UNITS: usize = 32;
const PLANET_NOTE_UTF16_UNITS: usize = 240;
const PLANET_TAG_UTF16_UNITS: usize = 16;
const PLANET_TAG_COUNT: usize = 8;

#[derive(Debug, Clone)]
struct WorkspaceIntent {
    kind: String,
    value: Map<String, Value>,
}

fn exact_intent_path(path: &[PathSegment]) -> bool {
    matches!(
        path,
        [PathSegment::Key(root), PathSegment::Key(leaf)]
            if root == INTENT_ROOT && leaf == INTENT_LEAF
    )
}

pub(crate) fn command_contains_intent(command: &SimulationCommandPatch) -> bool {
    command
        .top_level_changes
        .iter()
        .any(|change| exact_intent_path(&change.path))
}

fn valid_text(value: &str, max_bytes: usize) -> bool {
    !value.is_empty() && value.len() <= max_bytes && !value.chars().any(char::is_control)
}

fn required_string<'a>(
    value: &'a Map<String, Value>,
    key: &str,
    label: &str,
) -> anyhow::Result<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| valid_text(value, MAX_ID_BYTES))
        .ok_or_else(|| anyhow!("native workspace action {label} is invalid"))
}

fn optional_string<'a>(
    value: &'a Map<String, Value>,
    key: &str,
    max_bytes: usize,
    label: &str,
) -> anyhow::Result<Option<&'a str>> {
    match value.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_str()
            .filter(|value| value.len() <= max_bytes && !value.chars().any(char::is_control))
            .map(Some)
            .ok_or_else(|| anyhow!("native workspace action {label} is invalid")),
    }
}

fn required_u64(
    value: &Map<String, Value>,
    key: &str,
    minimum: u64,
    maximum: u64,
    label: &str,
) -> anyhow::Result<u64> {
    value
        .get(key)
        .and_then(Value::as_u64)
        .filter(|value| *value >= minimum && *value <= maximum)
        .ok_or_else(|| anyhow!("native workspace action {label} is invalid"))
}

fn required_number(value: &Map<String, Value>, key: &str, label: &str) -> anyhow::Result<f64> {
    value
        .get(key)
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .ok_or_else(|| anyhow!("native workspace action {label} is invalid"))
}

fn allowed_fields(value: &Map<String, Value>, fields: &[&str]) -> anyhow::Result<()> {
    if value.keys().any(|key| !fields.contains(&key.as_str())) {
        bail!("native workspace action contains an unexpected field")
    }
    Ok(())
}

fn require_intent(command: &SimulationCommandPatch) -> anyhow::Result<WorkspaceIntent> {
    if command.top_level_changes.len() != 1
        || !command.changed_entities.is_empty()
        || !command.added_entities.is_empty()
        || !command.removed_entity_ids.is_empty()
        || !command.changed_belts.is_empty()
        || !command.added_belts.is_empty()
        || !command.removed_belt_ids.is_empty()
    {
        bail!("native player-authority workspace action shape is invalid")
    }
    let change = &command.top_level_changes[0];
    if !exact_intent_path(&change.path) || change.operation != "set" {
        bail!("native player-authority workspace action path is invalid")
    }
    let value = change
        .value
        .as_ref()
        .and_then(Value::as_object)
        .cloned()
        .ok_or_else(|| anyhow!("native player-authority workspace action is invalid"))?;
    let kind = required_string(&value, "kind", "kind")?.to_owned();
    Ok(WorkspaceIntent { kind, value })
}

pub(crate) fn validate_resume_marker(command: &SimulationCommandPatch) -> anyhow::Result<()> {
    let intent = require_intent(command)?;
    validate_intent_shape(&intent)
}

fn validate_intent_shape(intent: &WorkspaceIntent) -> anyhow::Result<()> {
    let value = &intent.value;
    match intent.kind.as_str() {
        "handcraft-enqueue" => {
            allowed_fields(value, &["kind", "recipeId", "batches"])?;
            required_string(value, "recipeId", "recipe ID")?;
            required_u64(value, "batches", 1, MAX_BATCHES, "batch count")?;
        }
        "handcraft-cancel" => {
            allowed_fields(value, &["kind", "entryId"])?;
            required_string(value, "entryId", "queue entry ID")?;
        }
        "construction-discard" => {
            allowed_fields(value, &["kind", "constructionId"])?;
            required_string(value, "constructionId", "construction ID")?;
        }
        "tray-discard" => {
            allowed_fields(value, &["kind", "itemId", "amount"])?;
            required_string(value, "itemId", "tray item ID")?;
            required_u64(value, "amount", 1, MAX_SAFE_INTEGER, "tray discard amount")?;
        }
        "spray-detach" | "collector-item" => {
            let fields: &[&str] = if intent.kind == "collector-item" {
                &["kind", "entityId", "itemId"]
            } else {
                &["kind", "entityId"]
            };
            allowed_fields(value, fields)?;
            required_string(value, "entityId", "entity ID")?;
            if intent.kind == "collector-item" {
                required_string(value, "itemId", "item ID")?;
            }
        }
        "region-add" => {
            allowed_fields(
                value,
                &[
                    "kind",
                    "planetId",
                    "x",
                    "y",
                    "width",
                    "height",
                    "name",
                    "fillColor",
                    "borderColor",
                ],
            )?;
            required_string(value, "planetId", "planet ID")?;
            for key in ["x", "y", "width", "height"] {
                required_number(value, key, key)?;
            }
            optional_string(value, "name", 256, "region name")?;
            optional_string(value, "fillColor", 16, "region fill color")?;
            optional_string(value, "borderColor", 16, "region border color")?;
        }
        "region-update" => {
            allowed_fields(
                value,
                &["kind", "regionId", "name", "fillColor", "borderColor"],
            )?;
            required_string(value, "regionId", "region ID")?;
            if optional_string(value, "name", 256, "region name")?.is_none()
                && optional_string(value, "fillColor", 16, "region fill color")?.is_none()
                && optional_string(value, "borderColor", 16, "region border color")?.is_none()
            {
                bail!("native workspace region update is empty")
            }
        }
        "region-resize" => {
            allowed_fields(value, &["kind", "regionId", "x", "y", "width", "height"])?;
            required_string(value, "regionId", "region ID")?;
            for key in ["x", "y", "width", "height"] {
                required_number(value, key, key)?;
            }
        }
        "region-remove" => {
            allowed_fields(value, &["kind", "regionId"])?;
            required_string(value, "regionId", "region ID")?;
        }
        "bookmark-add" => {
            allowed_fields(value, &["kind", "planetId", "x", "y", "zoom", "name"])?;
            required_string(value, "planetId", "planet ID")?;
            for key in ["x", "y", "zoom"] {
                required_number(value, key, key)?;
            }
            optional_string(value, "name", 256, "bookmark name")?;
        }
        "bookmark-rename" => {
            allowed_fields(value, &["kind", "bookmarkId", "name"])?;
            required_string(value, "bookmarkId", "bookmark ID")?;
            required_string(value, "name", "bookmark name")?;
        }
        "bookmark-remove" => {
            allowed_fields(value, &["kind", "bookmarkId"])?;
            required_string(value, "bookmarkId", "bookmark ID")?;
        }
        "quantum-attach" => {
            allowed_fields(value, &["kind", "entityIds"])?;
            parse_unique_ids(value, "entityIds", 4_096)?;
        }
        "collector-quantum-mode" => {
            allowed_fields(value, &["kind", "entityIds", "enabled"])?;
            parse_unique_ids(value, "entityIds", 4_096)?;
            value
                .get("enabled")
                .and_then(Value::as_bool)
                .ok_or_else(|| anyhow!("native workspace collector quantum target is invalid"))?;
        }
        "station-upgrade-scope" | "quantum-attach-scope" => {
            allowed_fields(value, &["kind", "systemId"])?;
            if let Some(system_id) =
                optional_string(value, "systemId", MAX_ID_BYTES, "star-system scope")?
                && system_id.is_empty()
            {
                bail!("native workspace star-system scope is invalid")
            }
        }
        "collector-quantum-scope" => {
            allowed_fields(value, &["kind", "systemId", "enabled"])?;
            if let Some(system_id) =
                optional_string(value, "systemId", MAX_ID_BYTES, "star-system scope")?
                && system_id.is_empty()
            {
                bail!("native workspace star-system scope is invalid")
            }
            value
                .get("enabled")
                .and_then(Value::as_bool)
                .ok_or_else(|| anyhow!("native workspace collector quantum target is invalid"))?;
        }
        "system-explore" => {
            allowed_fields(value, &["kind", "systemId"])?;
            required_string(value, "systemId", "star-system ID")?;
        }
        "planet-colonize" => {
            allowed_fields(value, &["kind", "planetId"])?;
            required_string(value, "planetId", "planet ID")?;
        }
        "planet-metadata" => {
            allowed_fields(value, &["kind", "planetId", "customName", "note", "tags"])?;
            required_string(value, "planetId", "planet ID")?;
            for (key, label) in [("customName", "planet name"), ("note", "planet note")] {
                value
                    .get(key)
                    .and_then(Value::as_str)
                    .filter(|text| {
                        text.len() <= MAX_DISPLAY_TEXT_BYTES && !text.chars().any(char::is_control)
                    })
                    .ok_or_else(|| anyhow!("native workspace action {label} is invalid"))?;
            }
            let tags = value
                .get("tags")
                .and_then(Value::as_array)
                .filter(|tags| tags.len() <= PLANET_TAG_COUNT)
                .ok_or_else(|| anyhow!("native workspace planet tags are invalid"))?;
            if tags.iter().any(|tag| {
                tag.as_str().is_none_or(|tag| {
                    tag.len() > MAX_DISPLAY_TEXT_BYTES || tag.chars().any(char::is_control)
                })
            }) {
                bail!("native workspace planet tag is invalid")
            }
        }
        "system-rename" => {
            allowed_fields(value, &["kind", "systemId", "name"])?;
            required_string(value, "systemId", "star-system ID")?;
            value
                .get("name")
                .and_then(Value::as_str)
                .filter(|text| {
                    text.len() <= MAX_DISPLAY_TEXT_BYTES && !text.chars().any(char::is_control)
                })
                .ok_or_else(|| anyhow!("native workspace star-system name is invalid"))?;
        }
        _ => bail!("native workspace action kind is unsupported"),
    }
    Ok(())
}

fn parse_unique_ids(
    value: &Map<String, Value>,
    key: &str,
    limit: usize,
) -> anyhow::Result<Vec<String>> {
    let values = value
        .get(key)
        .and_then(Value::as_array)
        .filter(|values| !values.is_empty() && values.len() <= limit)
        .ok_or_else(|| anyhow!("native workspace action ID list is invalid"))?;
    let mut seen = HashSet::with_capacity(values.len());
    let mut result = Vec::with_capacity(values.len());
    for value in values {
        let id = value
            .as_str()
            .filter(|id| valid_text(id, MAX_ID_BYTES))
            .ok_or_else(|| anyhow!("native workspace action ID is invalid"))?;
        if !seen.insert(id) {
            bail!("native workspace action repeats an ID")
        }
        result.push(id.to_owned());
    }
    Ok(result)
}

fn completed_technology(state: &CoreState, technology_id: &str) -> bool {
    state
        .base_value()
        .get("research")
        .and_then(Value::as_object)
        .and_then(|research| research.get("completedTechIds"))
        .and_then(Value::as_array)
        .is_some_and(|ids| ids.iter().any(|id| id.as_str() == Some(technology_id)))
}

fn safe_integer(value: Option<&Value>, label: &str) -> anyhow::Result<u64> {
    match value {
        None | Some(Value::Null) => Ok(0),
        Some(value) => value
            .as_u64()
            .filter(|value| *value <= MAX_SAFE_INTEGER)
            .ok_or_else(|| anyhow!("native workspace action {label} is not a safe integer")),
    }
}

fn finite_nonnegative(value: Option<&Value>, label: &str) -> anyhow::Result<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value >= 0.0)
        .ok_or_else(|| anyhow!("native workspace action {label} is invalid"))
}

fn active_planet_id(base: &Map<String, Value>) -> anyhow::Result<&str> {
    base.get("activePlanetId")
        .and_then(Value::as_str)
        .filter(|id| valid_text(id, MAX_ID_BYTES))
        .ok_or_else(|| anyhow!("native workspace active planet is invalid"))
}

fn planet_exists(state: &CoreState, planet_id: &str) -> bool {
    state
        .catalog
        .planets
        .iter()
        .any(|planet| planet.id == planet_id)
}

fn truncate_name(value: &str) -> String {
    value.trim().chars().take(MAX_NAME_CHARS).collect()
}

fn valid_color(value: &str) -> bool {
    value.len() == 7
        && value.starts_with('#')
        && value.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
}

fn normalized_utf16_text(value: &str, maximum_units: usize) -> String {
    let mut units = 0usize;
    value
        .trim()
        .chars()
        .take_while(|character| {
            let next = units + character.len_utf16();
            if next > maximum_units {
                false
            } else {
                units = next;
                true
            }
        })
        .collect()
}

fn string_array_contains(value: Option<&Value>, expected: &str) -> bool {
    value
        .and_then(Value::as_array)
        .is_some_and(|rows| rows.iter().any(|row| row.as_str() == Some(expected)))
}

fn exact_item_amount(amount: f64, label: &str) -> anyhow::Result<u64> {
    if !amount.is_finite()
        || amount <= 0.0
        || amount.fract() != 0.0
        || amount > MAX_SAFE_INTEGER as f64
    {
        bail!("native workspace {label} is not an exact positive inventory amount")
    }
    Ok(amount as u64)
}

fn aggregate_catalog_costs<'a>(
    state: &CoreState,
    costs: impl IntoIterator<Item = (&'a str, f64)>,
    label: &str,
) -> anyhow::Result<BTreeMap<String, u64>> {
    let mut result = BTreeMap::new();
    for (item_id, amount) in costs {
        if !state.catalog.items.contains_key(item_id) {
            bail!("native workspace {label} references an unknown item")
        }
        let amount = exact_item_amount(amount, label)?;
        let current = result.entry(item_id.to_owned()).or_insert(0u64);
        *current = current
            .checked_add(amount)
            .filter(|value| *value <= MAX_SAFE_INTEGER)
            .ok_or_else(|| anyhow!("native workspace {label} overflows"))?;
    }
    Ok(result)
}

fn deduct_inventory(
    inventory: &mut Map<String, Value>,
    costs: &BTreeMap<String, u64>,
    label: &str,
) -> anyhow::Result<()> {
    for (item_id, amount) in costs {
        if safe_integer(inventory.get(item_id), label)? < *amount {
            bail!("native workspace {label} is insufficient")
        }
    }
    for (item_id, amount) in costs {
        let remaining = safe_integer(inventory.get(item_id), label)? - amount;
        inventory.insert(item_id.clone(), Value::from(remaining));
    }
    Ok(())
}

fn sync_active_planet_tray(base: &mut Map<String, Value>) -> anyhow::Result<()> {
    let planet_id = active_planet_id(base)?.to_owned();
    let tray = base
        .get("tray")
        .and_then(Value::as_object)
        .cloned()
        .ok_or_else(|| anyhow!("native workspace active tray is invalid"))?;
    base.get_mut("planetTrays")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native workspace planet trays are invalid"))?
        .insert(planet_id, Value::Object(tray));
    Ok(())
}

fn is_planet_colonized(state: &CoreState, base: &Map<String, Value>, planet_id: &str) -> bool {
    let Some(planet) = state
        .catalog
        .planets
        .iter()
        .find(|planet| planet.id == planet_id)
    else {
        return false;
    };
    let exploration = base.get("exploration").and_then(Value::as_object);
    if string_array_contains(
        exploration.and_then(|value| value.get("colonizedPlanetIds")),
        planet_id,
    ) {
        return true;
    }
    if planet.system_id == "helios"
        && planet_id != "home"
        && completed_technology(state, "interstellar_logistics")
    {
        return true;
    }
    state
        .catalog
        .star_systems
        .get(&planet.system_id)
        .is_some_and(|system| {
            system.planet_ids.first().is_some_and(|id| id == planet_id)
                && string_array_contains(
                    exploration.and_then(|value| value.get("unlockedSystemIds")),
                    &planet.system_id,
                )
        })
}

fn apply_system_explore(
    state: &CoreState,
    base: &mut Map<String, Value>,
    value: &Map<String, Value>,
) -> anyhow::Result<()> {
    let system_id = required_string(value, "systemId", "star-system ID")?;
    let system = state
        .catalog
        .star_systems
        .get(system_id)
        .cloned()
        .ok_or_else(|| anyhow!("native workspace star-system command directory is unavailable"))?;
    let exploration = base
        .get("exploration")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native workspace exploration state is invalid"))?;
    if string_array_contains(exploration.get("unlockedSystemIds"), system_id)
        || exploration
            .get("missions")
            .and_then(Value::as_array)
            .is_some_and(|missions| {
                missions.iter().any(|mission| {
                    mission.get("systemId").and_then(Value::as_str) == Some(system_id)
                })
            })
    {
        bail!("native workspace star system is already discovered")
    }
    if system
        .required_tech_id
        .as_deref()
        .is_some_and(|technology_id| !completed_technology(state, technology_id))
    {
        bail!("native workspace star-system technology is locked")
    }
    if system
        .prerequisite_system_id
        .as_deref()
        .is_some_and(|required| {
            !string_array_contains(exploration.get("unlockedSystemIds"), required)
        })
    {
        bail!("native workspace star-system prerequisite is locked")
    }
    let costs = aggregate_catalog_costs(
        state,
        system
            .exploration_cost
            .iter()
            .map(|cost| (cost.item_id.as_str(), cost.amount)),
        "star-system exploration cost",
    )?;
    let mut duration_seconds = 0.0f64;
    let profiles = base
        .get("galaxy")
        .and_then(Value::as_object)
        .and_then(|galaxy| galaxy.get("profiles"))
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native workspace galaxy profiles are invalid"))?;
    for planet_id in &system.planet_ids {
        let duration = profiles
            .get(planet_id)
            .and_then(Value::as_object)
            .and_then(|profile| profile.get("surveyDurationSeconds"))
            .and_then(Value::as_f64)
            .filter(|duration| duration.is_finite() && *duration >= 0.0)
            .ok_or_else(|| anyhow!("native workspace survey duration is invalid"))?;
        duration_seconds = duration_seconds.max(duration);
    }
    deduct_inventory(
        base.get_mut("tray")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native workspace active tray is invalid"))?,
        &costs,
        "star-system exploration inventory",
    )?;
    sync_active_planet_tray(base)?;
    let exploration = base
        .get_mut("exploration")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native workspace exploration state is invalid"))?;
    exploration
        .get_mut("unlockedSystemIds")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| anyhow!("native workspace unlocked system list is invalid"))?
        .push(Value::from(system_id));
    let progress = exploration
        .get_mut("surveyProgressBySystem")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native workspace survey progress is invalid"))?;
    if duration_seconds <= f64::EPSILON {
        progress.insert(system_id.to_owned(), Value::from(1));
    } else {
        progress.insert(system_id.to_owned(), Value::from(0));
        exploration
            .get_mut("missions")
            .and_then(Value::as_array_mut)
            .ok_or_else(|| anyhow!("native workspace exploration missions are invalid"))?
            .push(serde_json::json!({
                "systemId": system_id,
                "elapsedSeconds": 0,
                "durationSeconds": duration_seconds,
            }));
    }
    Ok(())
}

fn apply_planet_colonize(
    state: &CoreState,
    base: &mut Map<String, Value>,
    value: &Map<String, Value>,
) -> anyhow::Result<()> {
    let planet_id = required_string(value, "planetId", "planet ID")?;
    let planet = state
        .catalog
        .planets
        .iter()
        .find(|planet| planet.id == planet_id)
        .cloned()
        .ok_or_else(|| anyhow!("native workspace colony planet is unknown"))?;
    if !state.catalog.star_systems.contains_key(&planet.system_id) {
        bail!("native workspace star-system command directory is unavailable")
    }
    let exploration = base
        .get("exploration")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native workspace exploration state is invalid"))?;
    if !string_array_contains(exploration.get("unlockedSystemIds"), &planet.system_id) {
        bail!("native workspace colony star system is locked")
    }
    if is_planet_colonized(state, base, planet_id) {
        bail!("native workspace planet is already colonized")
    }
    let raw_costs = base
        .get("galaxy")
        .and_then(Value::as_object)
        .and_then(|galaxy| galaxy.get("profiles"))
        .and_then(Value::as_object)
        .and_then(|profiles| profiles.get(planet_id))
        .and_then(Value::as_object)
        .and_then(|profile| profile.get("colonyCost"))
        .and_then(Value::as_array)
        .filter(|rows| rows.len() <= 64)
        .ok_or_else(|| anyhow!("native workspace colony cost is invalid"))?;
    let mut tray_costs = BTreeMap::new();
    let mut fleet_costs = BTreeMap::new();
    for row in raw_costs {
        let row = row
            .as_object()
            .ok_or_else(|| anyhow!("native workspace colony cost row is invalid"))?;
        let item_id = required_string(row, "itemId", "colony cost item")?;
        if !state.catalog.items.contains_key(item_id) {
            bail!("native workspace colony cost item is unknown")
        }
        let amount = row
            .get("amount")
            .and_then(Value::as_f64)
            .ok_or_else(|| anyhow!("native workspace colony cost amount is invalid"))?;
        let amount = exact_item_amount(amount, "colony cost")?;
        let target = if matches!(item_id, "logistics_drone" | "logistics_vessel") {
            &mut fleet_costs
        } else {
            &mut tray_costs
        };
        let current = target.entry(item_id.to_owned()).or_insert(0u64);
        *current = current
            .checked_add(amount)
            .filter(|value| *value <= MAX_SAFE_INTEGER)
            .ok_or_else(|| anyhow!("native workspace colony cost overflows"))?;
    }
    deduct_inventory(
        base.get_mut("tray")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native workspace active tray is invalid"))?,
        &tray_costs,
        "colony tray inventory",
    )?;
    deduct_inventory(
        base.get_mut("portableFleet")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native workspace portable fleet is invalid"))?,
        &fleet_costs,
        "colony portable fleet",
    )?;
    sync_active_planet_tray(base)?;
    base.get_mut("exploration")
        .and_then(Value::as_object_mut)
        .and_then(|exploration| exploration.get_mut("colonizedPlanetIds"))
        .and_then(Value::as_array_mut)
        .ok_or_else(|| anyhow!("native workspace colonized planet list is invalid"))?
        .push(Value::from(planet_id));
    Ok(())
}

fn apply_planet_metadata(
    state: &CoreState,
    base: &mut Map<String, Value>,
    value: &Map<String, Value>,
) -> anyhow::Result<()> {
    let planet_id = required_string(value, "planetId", "planet ID")?;
    if !planet_exists(state, planet_id) {
        bail!("native workspace metadata planet is unknown")
    }
    let custom_name = normalized_utf16_text(
        value
            .get("customName")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        PLANET_NAME_UTF16_UNITS,
    );
    let note = normalized_utf16_text(
        value
            .get("note")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        PLANET_NOTE_UTF16_UNITS,
    );
    let mut seen = HashSet::new();
    let tags = value
        .get("tags")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("native workspace planet tags are invalid"))?
        .iter()
        .filter_map(Value::as_str)
        .map(|tag| normalized_utf16_text(tag, PLANET_TAG_UTF16_UNITS))
        .filter(|tag| !tag.is_empty() && seen.insert(tag.clone()))
        .take(PLANET_TAG_COUNT)
        .map(Value::from)
        .collect::<Vec<_>>();
    let galaxy = base
        .get_mut("galaxy")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native workspace galaxy state is invalid"))?;
    let metadata = galaxy
        .get_mut("planetMetadata")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native workspace planet metadata directory is invalid"))?;
    if custom_name.is_empty() && note.is_empty() && tags.is_empty() {
        metadata.remove(planet_id);
    } else {
        metadata.insert(
            planet_id.to_owned(),
            serde_json::json!({ "customName": custom_name, "note": note, "tags": tags }),
        );
    }
    Ok(())
}

fn apply_system_rename(
    state: &CoreState,
    base: &mut Map<String, Value>,
    value: &Map<String, Value>,
) -> anyhow::Result<()> {
    let system_id = required_string(value, "systemId", "star-system ID")?;
    if !state.catalog.star_systems.contains_key(system_id) {
        bail!("native workspace metadata star system is unknown")
    }
    let name = normalized_utf16_text(
        value
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        SYSTEM_NAME_UTF16_UNITS,
    );
    let metadata = base
        .get_mut("galaxy")
        .and_then(Value::as_object_mut)
        .and_then(|galaxy| galaxy.get_mut("systemMetadata"))
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native workspace system metadata directory is invalid"))?;
    if name.is_empty() {
        metadata.remove(system_id);
    } else {
        metadata.insert(
            system_id.to_owned(),
            serde_json::json!({ "customName": name }),
        );
    }
    Ok(())
}

fn next_id(base: &mut Map<String, Value>, prefix: &str) -> anyhow::Result<String> {
    let current = safe_integer(base.get("nextId"), "next ID")?;
    let next = current
        .checked_add(1)
        .filter(|value| *value <= MAX_SAFE_INTEGER)
        .ok_or_else(|| anyhow!("native workspace next ID overflows"))?;
    base.insert("nextId".to_owned(), Value::from(next));
    Ok(format!("{prefix}_{current}"))
}

fn apply_handcraft_enqueue(
    state: &CoreState,
    base: &mut Map<String, Value>,
    value: &Map<String, Value>,
) -> anyhow::Result<()> {
    let recipe_id = required_string(value, "recipeId", "recipe ID")?;
    let batches = required_u64(value, "batches", 1, MAX_BATCHES, "batch count")?;
    let recipe = state
        .catalog
        .recipes
        .get(recipe_id)
        .filter(|recipe| {
            !recipe.inputs.is_empty()
                && !recipe.outputs.is_empty()
                && !matches!(
                    recipe.id.as_str(),
                    "plasma_refining"
                        | "xray_cracking"
                        | "reforming_refine"
                        | "ray_power"
                        | "critical_photon"
                        | "matrix_research"
                        | "solar_sail_launch"
                        | "carrier_rocket_launch"
                        | "accumulator_charge"
                        | "accumulator_discharge"
                )
        })
        .ok_or_else(|| anyhow!("native workspace handcraft recipe is not handcraftable"))?;
    if recipe
        .required_tech_id
        .as_deref()
        .is_some_and(|id| !completed_technology(state, id))
    {
        bail!("native workspace handcraft technology is locked")
    }
    let planet_id = active_planet_id(base)?.to_owned();
    if !planet_exists(state, &planet_id) {
        bail!("native workspace handcraft planet is unknown")
    }
    let elapsed = finite_nonnegative(base.get("elapsedSeconds"), "elapsed time")?;
    let entry_id = next_id(base, "handcraft")?;
    let queue = base
        .get_mut("handcraftQueue")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| anyhow!("native workspace handcraft queue is invalid"))?;
    if queue.len() >= 20 {
        bail!("native workspace handcraft queue is full")
    }
    queue.push(serde_json::json!({
        "id": entry_id,
        "recipeId": recipe_id,
        "planetId": planet_id,
        "batchesTotal": batches,
        "batchesRemaining": batches,
        "progress": 0,
        "queuedAt": elapsed,
    }));
    Ok(())
}

fn apply_handcraft_cancel(
    base: &mut Map<String, Value>,
    value: &Map<String, Value>,
) -> anyhow::Result<()> {
    let entry_id = required_string(value, "entryId", "queue entry ID")?;
    let queue = base
        .get_mut("handcraftQueue")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| anyhow!("native workspace handcraft queue is invalid"))?;
    let before = queue.len();
    queue.retain(|entry| entry.get("id").and_then(Value::as_str) != Some(entry_id));
    if queue.len() == before {
        bail!("native workspace handcraft queue entry is missing")
    }
    Ok(())
}

fn apply_construction_discard(
    state: &CoreState,
    base: &mut Map<String, Value>,
    value: &Map<String, Value>,
) -> anyhow::Result<()> {
    let id = required_string(value, "constructionId", "construction ID")?;
    if !state.catalog.constructions.contains_key(id) {
        bail!("native workspace construction ID is unknown")
    }
    let construction = base
        .get_mut("construction")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native workspace construction inventory is invalid"))?;
    if safe_integer(construction.get(id), "construction inventory")? < 1 {
        bail!("native workspace construction inventory is empty")
    }
    construction.insert(id.to_owned(), Value::from(0));
    Ok(())
}

fn apply_tray_discard(
    state: &CoreState,
    base: &mut Map<String, Value>,
    value: &Map<String, Value>,
) -> anyhow::Result<()> {
    let item_id = required_string(value, "itemId", "tray item ID")?;
    if !state.catalog.items.contains_key(item_id) {
        bail!("native workspace tray discard item is unknown")
    }
    let amount = required_u64(value, "amount", 1, MAX_SAFE_INTEGER, "tray discard amount")?;
    let tray = base
        .get_mut("tray")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native workspace active tray is invalid"))?;
    let current = safe_integer(tray.get(item_id), "tray inventory")?;
    if current < amount {
        bail!("native workspace tray discard exceeds current inventory")
    }
    tray.insert(item_id.to_owned(), Value::from(current - amount));
    sync_active_planet_tray(base)?;
    Ok(())
}

fn canvas_rows_mut<'a>(
    base: &'a mut Map<String, Value>,
    key: &str,
) -> anyhow::Result<&'a mut Vec<Value>> {
    base.get_mut(key)
        .and_then(Value::as_array_mut)
        .ok_or_else(|| anyhow!("native workspace {key} is invalid"))
}

fn apply_region_action(
    state: &CoreState,
    base: &mut Map<String, Value>,
    intent: &WorkspaceIntent,
) -> anyhow::Result<()> {
    match intent.kind.as_str() {
        "region-add" => {
            let planet_id = required_string(&intent.value, "planetId", "planet ID")?.to_owned();
            if !planet_exists(state, &planet_id) {
                bail!("native workspace region planet is unknown")
            }
            let x = required_number(&intent.value, "x", "region x")?.round();
            let y = required_number(&intent.value, "y", "region y")?.round();
            let width = required_number(&intent.value, "width", "region width")?;
            let height = required_number(&intent.value, "height", "region height")?;
            if width < MIN_REGION_SIZE || height < MIN_REGION_SIZE {
                bail!("native workspace region is smaller than the minimum")
            }
            let name = optional_string(&intent.value, "name", 256, "region name")?
                .map(truncate_name)
                .filter(|value| !value.is_empty());
            let fill = optional_string(&intent.value, "fillColor", 16, "region fill color")?
                .unwrap_or("#2C6B66");
            let border = optional_string(&intent.value, "borderColor", 16, "region border color")?
                .unwrap_or("#67C7B5");
            if !valid_color(fill) || !valid_color(border) {
                bail!("native workspace region color is invalid")
            }
            let id = next_id(base, "region")?;
            let default_number = canvas_rows_mut(base, "canvasRegions")?.len() + 1;
            let rows = canvas_rows_mut(base, "canvasRegions")?;
            rows.push(serde_json::json!({
                "id": id,
                "name": name.unwrap_or_else(|| format!("生产区域 {default_number}")),
                "planetId": planet_id,
                "x": x,
                "y": y,
                "width": width.round().min(MAX_REGION_SIZE),
                "height": height.round().min(MAX_REGION_SIZE),
                "fillColor": fill.to_ascii_uppercase(),
                "borderColor": border.to_ascii_uppercase(),
            }));
            if rows.len() > 48 {
                rows.drain(..rows.len() - 48);
            }
        }
        "region-update" | "region-resize" => {
            let id = required_string(&intent.value, "regionId", "region ID")?;
            let rows = canvas_rows_mut(base, "canvasRegions")?;
            let region = rows
                .iter_mut()
                .find(|row| row.get("id").and_then(Value::as_str) == Some(id))
                .and_then(Value::as_object_mut)
                .ok_or_else(|| anyhow!("native workspace region is missing"))?;
            if intent.kind == "region-update" {
                if let Some(name) = optional_string(&intent.value, "name", 256, "region name")? {
                    let name = truncate_name(name);
                    if !name.is_empty() {
                        region.insert("name".to_owned(), Value::from(name));
                    }
                }
                for (field, key) in [("fillColor", "fillColor"), ("borderColor", "borderColor")] {
                    if let Some(color) = optional_string(&intent.value, key, 16, "region color")? {
                        if !valid_color(color) {
                            bail!("native workspace region color is invalid")
                        }
                        region.insert(field.to_owned(), Value::from(color.to_ascii_uppercase()));
                    }
                }
            } else {
                let x = required_number(&intent.value, "x", "region x")?.round();
                let y = required_number(&intent.value, "y", "region y")?.round();
                let width = required_number(&intent.value, "width", "region width")?
                    .round()
                    .clamp(MIN_REGION_SIZE, MAX_REGION_SIZE);
                let height = required_number(&intent.value, "height", "region height")?
                    .round()
                    .clamp(MIN_REGION_SIZE, MAX_REGION_SIZE);
                for (key, number) in [("x", x), ("y", y), ("width", width), ("height", height)] {
                    region.insert(key.to_owned(), Value::from(number));
                }
            }
        }
        "region-remove" => {
            let id = required_string(&intent.value, "regionId", "region ID")?;
            let rows = canvas_rows_mut(base, "canvasRegions")?;
            let before = rows.len();
            rows.retain(|row| row.get("id").and_then(Value::as_str) != Some(id));
            if rows.len() == before {
                bail!("native workspace region is missing")
            }
        }
        _ => unreachable!("region action dispatch"),
    }
    Ok(())
}

fn apply_bookmark_action(
    state: &CoreState,
    base: &mut Map<String, Value>,
    intent: &WorkspaceIntent,
) -> anyhow::Result<()> {
    match intent.kind.as_str() {
        "bookmark-add" => {
            let planet_id = required_string(&intent.value, "planetId", "planet ID")?.to_owned();
            let planet = state
                .catalog
                .planets
                .iter()
                .find(|planet| planet.id == planet_id)
                .ok_or_else(|| anyhow!("native workspace bookmark planet is unknown"))?;
            let name = optional_string(&intent.value, "name", 256, "bookmark name")?
                .map(truncate_name)
                .filter(|value| !value.is_empty());
            let x = required_number(&intent.value, "x", "bookmark x")?.round();
            let y = required_number(&intent.value, "y", "bookmark y")?.round();
            let zoom = ((required_number(&intent.value, "zoom", "bookmark zoom")? * 100.0).round()
                / 100.0)
                .clamp(0.1, 2.5);
            let elapsed = finite_nonnegative(base.get("elapsedSeconds"), "elapsed time")?;
            let id = next_id(base, "bookmark")?;
            let default_number = canvas_rows_mut(base, "canvasBookmarks")?.len() + 1;
            let rows = canvas_rows_mut(base, "canvasBookmarks")?;
            rows.push(serde_json::json!({
                "id": id,
                "name": name.unwrap_or_else(|| format!("{}视角 {default_number}", planet.name)),
                "planetId": planet_id,
                "viewport": { "x": x, "y": y, "zoom": zoom },
                "createdAtSeconds": elapsed,
            }));
            if rows.len() > 24 {
                rows.drain(..rows.len() - 24);
            }
        }
        "bookmark-rename" => {
            let id = required_string(&intent.value, "bookmarkId", "bookmark ID")?;
            let name = truncate_name(required_string(&intent.value, "name", "bookmark name")?);
            if name.is_empty() {
                bail!("native workspace bookmark name is empty")
            }
            let rows = canvas_rows_mut(base, "canvasBookmarks")?;
            let bookmark = rows
                .iter_mut()
                .find(|row| row.get("id").and_then(Value::as_str) == Some(id))
                .and_then(Value::as_object_mut)
                .ok_or_else(|| anyhow!("native workspace bookmark is missing"))?;
            bookmark.insert("name".to_owned(), Value::from(name));
        }
        "bookmark-remove" => {
            let id = required_string(&intent.value, "bookmarkId", "bookmark ID")?;
            let rows = canvas_rows_mut(base, "canvasBookmarks")?;
            let before = rows.len();
            rows.retain(|row| row.get("id").and_then(Value::as_str) != Some(id));
            if rows.len() == before {
                bail!("native workspace bookmark is missing")
            }
        }
        _ => unreachable!("bookmark action dispatch"),
    }
    Ok(())
}

fn add_inventory_amount(
    target: &mut Map<String, Value>,
    item_id: &str,
    amount: u64,
) -> anyhow::Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let current = safe_integer(target.get(item_id), "inventory amount")?;
    let next = current
        .checked_add(amount)
        .filter(|value| *value <= MAX_SAFE_INTEGER)
        .ok_or_else(|| anyhow!("native workspace inventory refund overflows"))?;
    target.insert(item_id.to_owned(), Value::from(next));
    Ok(())
}

fn add_to_planet_tray(
    base: &mut Map<String, Value>,
    planet_id: &str,
    item_id: &str,
    amount: u64,
) -> anyhow::Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let active = active_planet_id(base)? == planet_id;
    if active {
        let tray = base
            .get_mut("tray")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native workspace active tray is invalid"))?;
        add_inventory_amount(tray, item_id, amount)?;
        let active_snapshot = tray.clone();
        let planet_trays = base
            .get_mut("planetTrays")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native workspace planet trays are invalid"))?;
        planet_trays.insert(planet_id.to_owned(), Value::Object(active_snapshot));
    } else {
        let planet_trays = base
            .get_mut("planetTrays")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native workspace planet trays are invalid"))?;
        let tray = planet_trays
            .entry(planet_id.to_owned())
            .or_insert_with(|| Value::Object(Map::new()))
            .as_object_mut()
            .ok_or_else(|| anyhow!("native workspace planet tray is invalid"))?;
        add_inventory_amount(tray, item_id, amount)?;
    }
    Ok(())
}

fn belt_construction_id(state: &CoreState, tier: u8) -> anyhow::Result<String> {
    state
        .catalog
        .belt_construction_ids
        .get(&tier)
        .cloned()
        .or_else(|| match tier {
            1 => Some("conveyor_belt_mk1".to_owned()),
            2 => Some("conveyor_belt_mk2".to_owned()),
            3 => Some("conveyor_belt_mk3".to_owned()),
            _ => None,
        })
        .ok_or_else(|| anyhow!("native workspace belt tier is unsupported"))
}

fn refund_belts(
    state: &CoreState,
    base: &mut Map<String, Value>,
    belt_ids: &BTreeSet<String>,
) -> anyhow::Result<()> {
    let mut refunds = BTreeMap::<String, u64>::new();
    for id in belt_ids {
        let index = *state
            .belt_index
            .get(id)
            .ok_or_else(|| anyhow!("native workspace incident belt is missing"))?;
        let belt = state.parse_belt(index)?;
        let tier = safe_integer(belt.get("tier"), "belt tier")?;
        let tier =
            u8::try_from(tier).map_err(|_| anyhow!("native workspace belt tier is invalid"))?;
        let lanes = safe_integer(belt.get("lanes"), "belt lanes")?;
        let construction_id = belt_construction_id(state, tier)?;
        let current = refunds.entry(construction_id).or_default();
        *current = current
            .checked_add(lanes)
            .filter(|value| *value <= MAX_SAFE_INTEGER)
            .ok_or_else(|| anyhow!("native workspace belt refund overflows"))?;
    }
    let construction = base
        .get_mut("construction")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native workspace construction inventory is invalid"))?;
    for (id, amount) in refunds {
        add_inventory_amount(construction, &id, amount)?;
    }
    Ok(())
}

fn entity_change(
    state: &CoreState,
    entity_id: &str,
    candidate: Value,
) -> anyhow::Result<RecordPatch> {
    let index = *state
        .entity_index
        .get(entity_id)
        .ok_or_else(|| anyhow!("native workspace entity is missing"))?;
    let previous = state.parse_entity(index)?;
    let mut changes = Vec::new();
    create_expected_value_patches(&previous, &candidate, Vec::new(), &mut changes);
    if changes.is_empty() {
        bail!("native workspace entity action is unchanged")
    }
    Ok(RecordPatch {
        id: entity_id.to_owned(),
        changes,
    })
}

fn apply_spray_detach(
    state: &CoreState,
    base: &mut Map<String, Value>,
    value: &Map<String, Value>,
) -> anyhow::Result<(RecordPatch, BTreeSet<String>)> {
    let entity_id = required_string(value, "entityId", "entity ID")?;
    let index = *state
        .entity_index
        .get(entity_id)
        .ok_or_else(|| anyhow!("native workspace spray entity is missing"))?;
    let mut entity = state.parse_entity(index)?;
    let object = entity
        .as_object_mut()
        .ok_or_else(|| anyhow!("native workspace spray entity is invalid"))?;
    if object.get("interactionLocked").and_then(Value::as_bool) == Some(true)
        || object.get("sprayCoaterInstalled").and_then(Value::as_bool) != Some(true)
    {
        bail!("native workspace spray module cannot be detached")
    }
    let planet_id = object
        .get("planetId")
        .and_then(Value::as_str)
        .filter(|id| planet_exists(state, id))
        .ok_or_else(|| anyhow!("native workspace spray planet is invalid"))?
        .to_owned();
    let tier = safe_integer(object.get("proliferatorTier"), "proliferator tier")?;
    let definition = u8::try_from(tier)
        .ok()
        .and_then(|tier| state.catalog.proliferators.get(&tier));
    let proliferator_id = definition.map(|definition| definition.item_id.clone());
    let buffered = if let Some(item_id) = proliferator_id.as_deref() {
        object
            .get("inputs")
            .and_then(Value::as_object)
            .map(|inputs| safe_integer(inputs.get(item_id), "proliferator buffer"))
            .transpose()?
            .unwrap_or(0)
    } else {
        0
    };
    let points = safe_integer(object.get("proliferatorPoints"), "proliferator points")?;
    let recovered_points = definition
        .filter(|definition| definition.spray_points.is_finite() && definition.spray_points > 0.0)
        .map(|definition| ((points as f64) / definition.spray_points).ceil() as u64)
        .unwrap_or(0);
    if let Some(item_id) = proliferator_id.as_deref() {
        add_to_planet_tray(
            base,
            &planet_id,
            item_id,
            buffered.saturating_add(recovered_points),
        )?;
        if let Some(inputs) = object.get_mut("inputs").and_then(Value::as_object_mut) {
            inputs.insert(item_id.to_owned(), Value::from(0));
        }
    }
    let construction = base
        .get_mut("construction")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native workspace construction inventory is invalid"))?;
    add_inventory_amount(construction, "spray_coater", 1)?;

    let proliferator_ids = state
        .catalog
        .proliferators
        .values()
        .map(|definition| definition.item_id.as_str())
        .collect::<HashSet<_>>();
    let mut removed = BTreeSet::new();
    for belt_index in state.incident_belt_indices(index) {
        let belt = state.parse_belt(belt_index)?;
        if belt.get("target").and_then(Value::as_str) == Some(entity_id)
            && belt
                .get("itemId")
                .and_then(Value::as_str)
                .is_some_and(|id| proliferator_ids.contains(id))
        {
            let id = belt
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow!("native workspace spray belt ID is invalid"))?;
            removed.insert(id.to_owned());
        }
    }
    refund_belts(state, base, &removed)?;
    object.insert("sprayCoaterInstalled".to_owned(), Value::Bool(false));
    object.remove("proliferatorTier");
    object.remove("proliferatorMode");
    object.insert("proliferatorPoints".to_owned(), Value::from(0));
    object.insert(
        "proliferatorBonusProgress".to_owned(),
        Value::Object(Map::new()),
    );
    Ok((entity_change(state, entity_id, entity)?, removed))
}

fn apply_collector_item(
    state: &CoreState,
    base: &mut Map<String, Value>,
    value: &Map<String, Value>,
) -> anyhow::Result<(RecordPatch, BTreeSet<String>)> {
    let entity_id = required_string(value, "entityId", "entity ID")?;
    let item_id = required_string(value, "itemId", "item ID")?;
    if !state.catalog.items.contains_key(item_id) {
        bail!("native workspace collector item is unknown")
    }
    let index = *state
        .entity_index
        .get(entity_id)
        .ok_or_else(|| anyhow!("native workspace collector is missing"))?;
    let mut entity = state.parse_entity(index)?;
    let object = entity
        .as_object_mut()
        .ok_or_else(|| anyhow!("native workspace collector is invalid"))?;
    if object.get("buildingId").and_then(Value::as_str) != Some("orbital_collector")
        || object.get("interactionLocked").and_then(Value::as_bool) == Some(true)
        || object.get("storedItemId").and_then(Value::as_str) == Some(item_id)
    {
        bail!("native workspace collector item change is unavailable")
    }
    let planet_id = object
        .get("planetId")
        .and_then(Value::as_str)
        .filter(|id| planet_exists(state, id))
        .ok_or_else(|| anyhow!("native workspace collector planet is invalid"))?
        .to_owned();
    let supported = state
        .catalog
        .planets
        .iter()
        .find(|planet| planet.id == planet_id)
        .and_then(|planet| planet.orbital_yields.get(item_id))
        .is_some_and(|rate| rate.is_finite() && *rate > 0.0);
    if !supported {
        bail!("native workspace collector item has no orbital yield")
    }
    for field in ["inputs", "outputs"] {
        let inventory = object
            .get(field)
            .and_then(Value::as_object)
            .ok_or_else(|| anyhow!("native workspace collector inventory is invalid"))?
            .clone();
        for (buffered_id, amount) in inventory {
            let amount = safe_integer(Some(&amount), "collector buffer")?;
            add_to_planet_tray(base, &planet_id, &buffered_id, amount)?;
        }
        object.insert(field.to_owned(), Value::Object(Map::new()));
    }
    object.insert("storedItemId".to_owned(), Value::from(item_id));
    object.insert("routingCursor".to_owned(), Value::from(0));
    object.insert("stationProgress".to_owned(), Value::from(0));
    object.remove("stationPeerId");
    let mut removed = BTreeSet::new();
    for belt_index in state.incident_belt_indices(index) {
        let belt = state.parse_belt(belt_index)?;
        let id = belt
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("native workspace collector belt ID is invalid"))?;
        removed.insert(id.to_owned());
    }
    refund_belts(state, base, &removed)?;
    Ok((entity_change(state, entity_id, entity)?, removed))
}

fn apply_quantum_action(
    state: &CoreState,
    base: &Map<String, Value>,
    intent: &WorkspaceIntent,
) -> anyhow::Result<Vec<RecordPatch>> {
    let ids = parse_unique_ids(&intent.value, "entityIds", 4_096)?;
    let collector_target = (intent.kind == "collector-quantum-mode")
        .then(|| {
            intent
                .value
                .get("enabled")
                .and_then(Value::as_bool)
                .map(|enabled| if enabled { "quantum" } else { "legacy" })
                .ok_or_else(|| anyhow!("native workspace collector quantum target is invalid"))
        })
        .transpose()?;
    let replacements = crate::quantum_logistics::prepare_player_quantum_mode_changes(
        state,
        base,
        &ids,
        collector_target,
    )?;
    replacements
        .into_iter()
        .map(|(entity_id, candidate)| entity_change(state, &entity_id, candidate))
        .collect()
}

fn expand_quantum_scope_intent(
    state: &CoreState,
    intent: &WorkspaceIntent,
) -> anyhow::Result<WorkspaceIntent> {
    let system_id = optional_string(&intent.value, "systemId", MAX_ID_BYTES, "star-system scope")?;
    if let Some(system_id) = system_id
        && !state.catalog.star_systems.contains_key(system_id)
    {
        bail!("native workspace quantum star-system scope is unknown")
    }
    let collector = intent.kind == "collector-quantum-scope";
    let expected_building = if collector {
        "orbital_collector"
    } else {
        "interstellar_logistics_station"
    };
    let mut ids = Vec::new();
    for index in 0..state.entity_index.len() {
        let entity = state.parse_entity(index)?;
        let object = entity
            .as_object()
            .ok_or_else(|| anyhow!("native workspace quantum scope entity is invalid"))?;
        if object.get("buildingId").and_then(Value::as_str) != Some(expected_building) {
            continue;
        }
        let planet_id = object
            .get("planetId")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("native workspace quantum scope planet is invalid"))?;
        let planet_system_id = state
            .catalog
            .planets
            .iter()
            .find(|planet| planet.id == planet_id)
            .map(|planet| planet.system_id.as_str())
            .ok_or_else(|| anyhow!("native workspace quantum scope planet is unknown"))?;
        if system_id.is_some_and(|expected| expected != planet_system_id) {
            continue;
        }
        let id = object
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| valid_text(id, MAX_ID_BYTES))
            .ok_or_else(|| anyhow!("native workspace quantum scope entity ID is invalid"))?;
        ids.push(id.to_owned());
        if ids.len() > 4_096 {
            bail!("native workspace quantum scope exceeds its bounded target limit")
        }
    }
    ids.sort_unstable();
    let mut value = Map::new();
    let kind =
        if collector {
            value.insert(
                "enabled".to_owned(),
                intent.value.get("enabled").cloned().ok_or_else(|| {
                    anyhow!("native workspace collector quantum target is missing")
                })?,
            );
            "collector-quantum-mode"
        } else {
            "quantum-attach"
        };
    value.insert("kind".to_owned(), Value::from(kind));
    value.insert(
        "entityIds".to_owned(),
        Value::Array(ids.into_iter().map(Value::from).collect()),
    );
    Ok(WorkspaceIntent {
        kind: kind.to_owned(),
        value,
    })
}

pub(crate) fn validate_command(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<()> {
    expand_intent(state, command).map(|_| ())
}

pub(crate) fn expand_intent(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<SimulationCommandPatch> {
    let intent = require_intent(command)?;
    validate_intent_shape(&intent)?;
    if intent.kind == "station-upgrade-scope" {
        return crate::system_space_station_command::expand_interstellar_upgrade_scope(
            state,
            optional_string(&intent.value, "systemId", MAX_ID_BYTES, "star-system scope")?,
        );
    }
    let previous_base = Value::Object(state.base_value().clone());
    let mut candidate_base = state.base_value().clone();
    let mut changed_entities = Vec::new();
    let mut removed_belts = BTreeSet::new();
    match intent.kind.as_str() {
        "handcraft-enqueue" => apply_handcraft_enqueue(state, &mut candidate_base, &intent.value)?,
        "handcraft-cancel" => apply_handcraft_cancel(&mut candidate_base, &intent.value)?,
        "construction-discard" => {
            apply_construction_discard(state, &mut candidate_base, &intent.value)?
        }
        "tray-discard" => apply_tray_discard(state, &mut candidate_base, &intent.value)?,
        "region-add" | "region-update" | "region-resize" | "region-remove" => {
            apply_region_action(state, &mut candidate_base, &intent)?
        }
        "bookmark-add" | "bookmark-rename" | "bookmark-remove" => {
            apply_bookmark_action(state, &mut candidate_base, &intent)?
        }
        "spray-detach" => {
            let (record, removed) = apply_spray_detach(state, &mut candidate_base, &intent.value)?;
            changed_entities.push(record);
            removed_belts.extend(removed);
        }
        "collector-item" => {
            let (record, removed) =
                apply_collector_item(state, &mut candidate_base, &intent.value)?;
            changed_entities.push(record);
            removed_belts.extend(removed);
        }
        "quantum-attach" | "collector-quantum-mode" => {
            changed_entities = apply_quantum_action(state, &candidate_base, &intent)?;
        }
        "quantum-attach-scope" | "collector-quantum-scope" => {
            let scoped = expand_quantum_scope_intent(state, &intent)?;
            changed_entities = apply_quantum_action(state, &candidate_base, &scoped)?;
        }
        "system-explore" => apply_system_explore(state, &mut candidate_base, &intent.value)?,
        "planet-colonize" => apply_planet_colonize(state, &mut candidate_base, &intent.value)?,
        "planet-metadata" => apply_planet_metadata(state, &mut candidate_base, &intent.value)?,
        "system-rename" => apply_system_rename(state, &mut candidate_base, &intent.value)?,
        _ => unreachable!("validated workspace action kind"),
    }
    let mut top_level_changes = Vec::new();
    create_expected_value_patches(
        &previous_base,
        &Value::Object(candidate_base),
        Vec::new(),
        &mut top_level_changes,
    );
    changed_entities.sort_by(|left, right| left.id.cmp(&right.id));
    let removed_belt_ids = removed_belts.into_iter().collect::<Vec<_>>();
    let count = top_level_changes
        .len()
        .checked_add(
            changed_entities
                .iter()
                .map(|record| record.changes.len())
                .sum(),
        )
        .and_then(|count| count.checked_add(removed_belt_ids.len()))
        .ok_or_else(|| anyhow!("native workspace action change count overflows"))?;
    if count == 0 || count > MAX_EXPANDED_CHANGES {
        bail!("native workspace action is empty or exceeds its change budget")
    }
    Ok(SimulationCommandPatch {
        protocol_version: command.protocol_version,
        base_revision: command.base_revision,
        top_level_changes,
        changed_entities,
        added_entities: Vec::new(),
        removed_entity_ids: Vec::new(),
        changed_belts: Vec::new(),
        added_belts: Vec::new(),
        removed_belt_ids,
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::{CoreCheckpointIdentity, catalog::RuntimeCatalog};

    const REGISTRY: &str = "workspace-action-test";

    fn catalog() -> RuntimeCatalog {
        RuntimeCatalog::from_value(
            json!({
                "protocolVersion": crate::CORE_PROTOCOL_VERSION,
                "registryFingerprint": REGISTRY,
                "planets": [
                    { "id": "home", "name": "Home", "systemId": "helios", "kind": "terrestrial", "orbitIndex": 1 },
                    { "id": "gas", "name": "Gas", "systemId": "helios", "kind": "gas-giant", "orbitIndex": 2,
                      "orbitalYields": { "hydrogen": 10, "deuterium": 1 } },
                    { "id": "remote", "name": "Remote", "systemId": "sigma", "kind": "terrestrial", "orbitIndex": 1 },
                    { "id": "moon", "name": "Moon", "systemId": "sigma", "kind": "terrestrial", "orbitIndex": 2 }
                ],
                "starSystems": [
                    { "id": "helios", "name": "Helios", "planetIds": ["home", "gas"] },
                    { "id": "sigma", "name": "Sigma", "planetIds": ["remote", "moon"],
                      "explorationCost": [{ "itemId": "ore", "amount": 5 }],
                      "requiredTechId": "interstellar_logistics", "prerequisiteSystemId": "helios" }
                ],
                "items": [
                    { "id": "ore", "name": "Ore", "kind": "solid" },
                    { "id": "plate", "name": "Plate", "kind": "solid" },
                    { "id": "proliferator_mk1", "name": "Spray", "kind": "solid" },
                    { "id": "hydrogen", "name": "Hydrogen", "kind": "fluid" },
                    { "id": "deuterium", "name": "Deuterium", "kind": "fluid" },
                    { "id": "logistics_vessel", "name": "Vessel", "kind": "solid" }
                ],
                "buildings": [
                    { "id": "assembler", "name": "Assembler", "kind": "machine", "speed": 1,
                      "inputCapacity": 100, "outputCapacity": 100, "stackLimit": 100, "stackLimitComplete": true },
                    { "id": "spray_coater", "name": "Spray Coater", "kind": "machine", "speed": 1,
                      "inputCapacity": 100, "outputCapacity": 100, "stackLimit": 100, "stackLimitComplete": true },
                    { "id": "interstellar_logistics_station", "name": "ILS", "kind": "station", "speed": 1,
                      "inputCapacity": 100, "outputCapacity": 100, "stackLimit": 100, "stackLimitComplete": true },
                    { "id": "orbital_collector", "name": "Collector", "kind": "station", "speed": 1,
                      "inputCapacity": 100, "outputCapacity": 100, "stackLimit": 100, "stackLimitComplete": true }
                ],
                "recipes": [{
                    "id": "plate_recipe", "name": "Plate", "buildingId": "assembler", "duration": 1,
                    "inputs": [{ "itemId": "ore", "amount": 1 }],
                    "outputs": [{ "itemId": "plate", "amount": 1 }]
                }],
                "constructions": [
                    { "id": "assembler", "outputAmount": 1, "costs": [{ "itemId": "ore", "amount": 1 }] },
                    { "id": "spray_coater", "outputAmount": 1, "costs": [{ "itemId": "ore", "amount": 1 }] },
                    { "id": "conveyor_belt_mk1", "outputAmount": 1, "costs": [{ "itemId": "ore", "amount": 1 }] }
                ],
                "belts": [{ "tier": 1, "speed": 6, "id": "conveyor_belt_mk1", "constructionId": "conveyor_belt_mk1" }],
                "proliferators": [{
                    "tier": 1, "itemId": "proliferator_mk1", "sprayPoints": 12,
                    "extraProductBonus": 0.125, "speedBonus": 0.25, "powerMultiplier": 1.3,
                    "requiredTechId": "proliferator_1"
                }],
                "technologies": [
                    { "id": "proliferator_1", "name": "Spray", "costs": [{ "itemId": "ore", "amount": 1 }] },
                    { "id": "quantum_logistics_network", "name": "Quantum", "costs": [{ "itemId": "ore", "amount": 1 }] },
                    { "id": "interstellar_logistics", "name": "Interstellar", "costs": [{ "itemId": "ore", "amount": 1 }] }
                ]
            }),
            REGISTRY,
        )
        .unwrap()
    }

    fn entity(value: Value) -> String {
        serde_json::to_string(&value).unwrap()
    }

    fn state() -> CoreState {
        let base = json!({
            "version": 47,
            "mode": "normal",
            "activePlanetId": "home",
            "elapsedSeconds": 12,
            "paused": false,
            "nextId": 30,
            "tray": { "ore": 20 },
            "planetTrays": { "home": { "ore": 20 }, "gas": {}, "remote": {}, "moon": {} },
            "portableFleet": { "logistics_drone": 0, "logistics_vessel": 2 },
            "construction": { "assembler": 4, "spray_coater": 2, "conveyor_belt_mk1": 2 },
            "research": { "completedTechIds": ["proliferator_1", "quantum_logistics_network", "interstellar_logistics"] },
            "settings": { "simulationSpeed": 1 },
            "exploration": {
                "colonizedPlanetIds": ["home", "gas"],
                "unlockedSystemIds": ["helios"],
                "missions": [],
                "surveyProgressBySystem": { "helios": 1 }
            },
            "galaxy": {
                "profiles": {
                    "home": { "surveyDurationSeconds": 0, "colonyCost": [] },
                    "gas": { "surveyDurationSeconds": 0, "colonyCost": [] },
                    "remote": { "surveyDurationSeconds": 20, "colonyCost": [] },
                    "moon": { "surveyDurationSeconds": 30, "colonyCost": [
                        { "itemId": "ore", "amount": 2 },
                        { "itemId": "logistics_vessel", "amount": 1 }
                    ] }
                },
                "planetMetadata": {},
                "systemMetadata": {}
            },
            "constructionQueue": [],
            "blueprintVersions": [],
            "handcraftQueue": [],
            "canvasRegions": [],
            "canvasBookmarks": [],
            "quantumLogisticsNetwork": { "enabled": false, "inventory": {}, "itemCapacities": {} }
        })
        .as_object()
        .unwrap()
        .clone();
        let entities = vec![
            entity(json!({
                "id": "machine", "kind": "machine", "planetId": "home", "buildingId": "assembler",
                "machineCount": 1, "interactionLocked": false, "inputs": { "proliferator_mk1": 3 },
                "outputs": {}, "progress": 0, "utilization": 0, "productionRate": 0,
                "sprayCoaterInstalled": true, "proliferatorTier": 1, "proliferatorMode": "normal",
                "proliferatorPoints": 13, "proliferatorBonusProgress": {}, "position": { "x": 0, "y": 0 }
            })),
            entity(json!({
                "id": "ils", "kind": "station", "planetId": "home", "buildingId": "interstellar_logistics_station",
                "machineCount": 1, "interactionLocked": false, "inputs": {}, "outputs": {},
                "stationTier": 2, "quantumMode": "legacy", "quantumTransition": null,
                "stationRoutes": [], "position": { "x": 400, "y": 0 }
            })),
            entity(json!({
                "id": "collector", "kind": "station", "planetId": "gas", "buildingId": "orbital_collector",
                "machineCount": 1, "interactionLocked": false, "inputs": { "hydrogen": 4 },
                "outputs": { "hydrogen": 6 }, "storedItemId": "hydrogen", "quantumMode": "legacy",
                "quantumTransition": null, "stationRoutes": [], "position": { "x": 800, "y": 0 }
            })),
        ];
        let belts = vec![
            serde_json::to_string(&json!({
                "id": "spray-belt", "planetId": "home", "source": "ils", "target": "machine",
                "itemId": "proliferator_mk1", "tier": 1, "sorterTier": 1, "lanes": 2,
                "progress": 0, "priority": 1, "stackSize": 1, "monitorEnabled": false,
                "totalTransferred": 0, "congestion": 0, "lastFlow": 0, "routeMode": "auto"
            }))
            .unwrap(),
        ];
        CoreState::from_public_v47_parts(
            CoreCheckpointIdentity {
                slot: "normal-main".to_owned(),
                generation: 1,
                root_hash: "a".repeat(64),
                revision: 7,
                state_version: 47,
                mode: "normal".to_owned(),
                registry_fingerprint: REGISTRY.to_owned(),
                base_primary_checksum: "12345678".to_owned(),
            },
            base,
            entities,
            belts,
            catalog(),
        )
        .unwrap()
    }

    fn marker(value: Value) -> SimulationCommandPatch {
        serde_json::from_value(json!({
            "protocolVersion": crate::CORE_PROTOCOL_VERSION,
            "baseRevision": 7,
            "topLevelChanges": [{ "path": ["workspaceAction", "intent"], "operation": "set", "value": value }],
            "changedEntities": [], "addedEntities": [], "removedEntityIds": [],
            "changedBelts": [], "addedBelts": [], "removedBeltIds": []
        })).unwrap()
    }

    #[test]
    fn handcraft_regions_bookmarks_and_discard_replay_deterministically() {
        let commands = [
            marker(
                json!({ "kind": "handcraft-enqueue", "recipeId": "plate_recipe", "batches": 5 }),
            ),
            marker(
                json!({ "kind": "region-add", "planetId": "home", "x": 10, "y": 20, "width": 100, "height": 80 }),
            ),
            marker(
                json!({ "kind": "bookmark-add", "planetId": "home", "x": 1, "y": 2, "zoom": 0.84 }),
            ),
            marker(json!({ "kind": "construction-discard", "constructionId": "assembler" })),
            marker(json!({ "kind": "tray-discard", "itemId": "ore", "amount": 6 })),
        ];
        let mut live = state();
        let mut replay = state();
        for (offset, command) in commands.iter().enumerate() {
            let mut command = command.clone();
            command.base_revision = 7 + offset as u64;
            live.apply_player_authority_command(&command).unwrap();
            replay.apply_command(&command).unwrap();
        }
        assert_eq!(
            live.canonical_sha256().unwrap(),
            replay.canonical_sha256().unwrap()
        );
        assert_eq!(
            live.base_value()["handcraftQueue"][0]["batchesRemaining"],
            5
        );
        assert_eq!(live.base_value()["canvasRegions"][0]["id"], "region_31");
        assert_eq!(live.base_value()["canvasBookmarks"][0]["id"], "bookmark_32");
        assert_eq!(live.base_value()["construction"]["assembler"], 0);
        assert_eq!(live.base_value()["tray"]["ore"], 14);
        assert_eq!(live.base_value()["planetTrays"]["home"]["ore"], 14);
    }

    #[test]
    fn spray_and_collector_actions_rederive_refunds_and_remove_incident_belts() {
        let mut spray = state();
        spray
            .apply_player_authority_command(&marker(json!({
                "kind": "spray-detach", "entityId": "machine"
            })))
            .unwrap();
        assert!(
            !spray.parse_entity(0).unwrap()["sprayCoaterInstalled"]
                .as_bool()
                .unwrap()
        );
        assert!(spray.belt_index.is_empty());
        assert_eq!(spray.base_value()["construction"]["spray_coater"], 3);
        assert_eq!(spray.base_value()["construction"]["conveyor_belt_mk1"], 4);
        // 3 buffered + ceil(13 / 12) recovered point items.
        assert_eq!(spray.base_value()["tray"]["proliferator_mk1"], 5);

        let mut collector = state();
        collector
            .apply_player_authority_command(&marker(json!({
                "kind": "collector-item", "entityId": "collector", "itemId": "deuterium"
            })))
            .unwrap();
        assert_eq!(
            collector.parse_entity(2).unwrap()["storedItemId"],
            "deuterium"
        );
        assert_eq!(collector.base_value()["planetTrays"]["gas"]["hydrogen"], 10);
    }

    #[test]
    fn station_and_collector_quantum_handoffs_are_bounded_and_atomic() {
        let mut station = state();
        station
            .apply_player_authority_command(&marker(json!({
                "kind": "quantum-attach", "entityIds": ["ils"]
            })))
            .unwrap();
        let ils = station.parse_entity(1).unwrap();
        assert_eq!(ils["quantumMode"], "transitioning");
        assert_eq!(ils["quantumTransition"]["targetMode"], "quantum");

        let mut collector = state();
        collector
            .apply_player_authority_command(&marker(json!({
                "kind": "collector-quantum-mode", "entityIds": ["collector"], "enabled": true
            })))
            .unwrap();
        assert_eq!(
            collector.parse_entity(2).unwrap()["quantumMode"],
            "transitioning"
        );

        let mut invalid = state();
        let before = invalid.canonical_sha256().unwrap();
        assert!(
            invalid
                .apply_player_authority_command(&marker(json!({
                    "kind": "quantum-attach", "entityIds": ["missing"]
                })))
                .is_err()
        );
        assert_eq!(invalid.revision, 7);
        assert_eq!(invalid.canonical_sha256().unwrap(), before);

        let mut scoped_station = state();
        scoped_station
            .apply_player_authority_command(&marker(json!({
                "kind": "quantum-attach-scope", "systemId": "helios"
            })))
            .unwrap();
        assert_eq!(
            scoped_station.parse_entity(1).unwrap()["quantumMode"],
            "transitioning"
        );

        let mut scoped_collector = state();
        scoped_collector
            .apply_player_authority_command(&marker(json!({
                "kind": "collector-quantum-scope", "systemId": "helios", "enabled": true
            })))
            .unwrap();
        assert_eq!(
            scoped_collector.parse_entity(2).unwrap()["quantumMode"],
            "transitioning"
        );
    }

    #[test]
    fn exploration_colony_and_metadata_are_native_atomic_and_material_backed() {
        let mut blocked = state();
        let before = blocked.canonical_sha256().unwrap();
        assert!(
            blocked
                .apply_player_authority_command(&marker(json!({
                    "kind": "planet-colonize", "planetId": "moon"
                })))
                .is_err()
        );
        assert_eq!(blocked.revision, 7);
        assert_eq!(blocked.canonical_sha256().unwrap(), before);

        let mut live = state();
        let mut explore = marker(json!({ "kind": "system-explore", "systemId": "sigma" }));
        live.apply_player_authority_command(&explore).unwrap();
        assert_eq!(live.base_value()["tray"]["ore"], 15);
        assert_eq!(live.base_value()["planetTrays"]["home"]["ore"], 15);
        assert_eq!(
            live.base_value()["exploration"]["missions"][0]["durationSeconds"].as_f64(),
            Some(30.0)
        );

        let mut colonize = marker(json!({ "kind": "planet-colonize", "planetId": "moon" }));
        colonize.base_revision = 8;
        live.apply_player_authority_command(&colonize).unwrap();
        assert_eq!(live.base_value()["tray"]["ore"], 13);
        assert_eq!(live.base_value()["portableFleet"]["logistics_vessel"], 1);
        assert!(string_array_contains(
            live.base_value()["exploration"].get("colonizedPlanetIds"),
            "moon"
        ));

        let mut metadata = marker(json!({
            "kind": "planet-metadata",
            "planetId": "moon",
            "customName": "  工业月  ",
            "note": "  主物流节点  ",
            "tags": ["出口", "出口", " 供电 "]
        }));
        metadata.base_revision = 9;
        live.apply_player_authority_command(&metadata).unwrap();
        assert_eq!(
            live.base_value()["galaxy"]["planetMetadata"]["moon"]["customName"],
            "工业月"
        );
        assert_eq!(
            live.base_value()["galaxy"]["planetMetadata"]["moon"]["tags"],
            json!(["出口", "供电"])
        );

        let mut rename = marker(json!({
            "kind": "system-rename", "systemId": "sigma", "name": "  北方工业区  "
        }));
        rename.base_revision = 10;
        live.apply_player_authority_command(&rename).unwrap();
        assert_eq!(
            live.base_value()["galaxy"]["systemMetadata"]["sigma"]["customName"],
            "北方工业区"
        );

        explore.base_revision = 11;
        let stable = live.canonical_sha256().unwrap();
        assert!(live.apply_player_authority_command(&explore).is_err());
        assert_eq!(live.revision, 11);
        assert_eq!(live.canonical_sha256().unwrap(), stable);
    }
}
