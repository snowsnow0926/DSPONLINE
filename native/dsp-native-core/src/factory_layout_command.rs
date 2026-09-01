//! Compact durable intent for deterministic factory auto-layout.
//!
//! The renderer submits only the requested scope and opaque selected IDs.
//! Rust re-reads the current active planet, entity rows and resident belt
//! topology, computes the layout, and expands it to ordinary position patches
//! inside the transactional command engine. No stale renderer GameState or
//! renderer-authored coordinates cross the authority boundary.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use anyhow::{anyhow, bail};
use serde_json::Value;

use crate::{
    command::{PathSegment, RecordPatch, SimulationCommandPatch, ValuePatch},
    state::CoreState,
};

const INTENT_ROOT: &str = "factoryAutoLayout";
const INTENT_LEAF: &str = "intent";
const MAX_SELECTION_ROWS: usize = 4_096;
const MAX_MOVABLE_ROWS: usize = 65_536;
const MAX_OPAQUE_ID_BYTES: usize = 512;
const COLUMN_GAP: f64 = 340.0;
const ROW_GAP: f64 = 240.0;
const GRID_SIZE: f64 = 20.0;
const MAX_ROW_OFFSETS: usize = 512;
const COLLISION_CELL_SIZE: f64 = 1_024.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LayoutScope {
    All,
    Selection,
}

#[derive(Debug, Clone)]
struct LayoutIntent {
    scope: LayoutScope,
    entity_ids: Vec<String>,
}

#[derive(Debug, Clone)]
struct LayoutEntity {
    entity_index: usize,
    id: String,
    kind: String,
    sort_label: String,
    interaction_locked: bool,
    x: f64,
    y: f64,
    layout_width: f64,
    layout_height: f64,
    layout_clearance: f64,
}

#[derive(Debug, Clone)]
struct LayoutMove {
    entity_id: String,
    before_x: f64,
    before_y: f64,
    after_x: f64,
    after_y: f64,
}

impl LayoutEntity {
    fn order_key(&self) -> (u8, &str, &str) {
        let rank = match self.kind.as_str() {
            "vein" => 0,
            "storage" | "station" => 1,
            _ => 2,
        };
        (rank, &self.sort_label, &self.id)
    }
}

#[derive(Debug, Clone, Copy)]
struct CollisionBounds {
    left: f64,
    top: f64,
    right: f64,
    bottom: f64,
}

impl CollisionBounds {
    fn collides(self, other: Self) -> bool {
        self.left < other.right
            && self.right > other.left
            && self.top < other.bottom
            && self.bottom > other.top
    }
}

#[derive(Debug, Default)]
struct SpatialObstacles {
    bounds: Vec<CollisionBounds>,
    cells: HashMap<(i64, i64), Vec<usize>>,
}

impl SpatialObstacles {
    fn coordinate(value: f64) -> anyhow::Result<i64> {
        let scaled = (value / COLLISION_CELL_SIZE).floor();
        if !scaled.is_finite() || scaled < i64::MIN as f64 || scaled > i64::MAX as f64 {
            bail!("native factory layout collision coordinate is invalid");
        }
        Ok(scaled as i64)
    }

    fn cell_range(bounds: CollisionBounds) -> anyhow::Result<(i64, i64, i64, i64)> {
        Ok((
            Self::coordinate(bounds.left)?,
            Self::coordinate(bounds.top)?,
            Self::coordinate(bounds.right)?,
            Self::coordinate(bounds.bottom)?,
        ))
    }

    fn insert(&mut self, bounds: CollisionBounds) -> anyhow::Result<()> {
        let (min_x, min_y, max_x, max_y) = Self::cell_range(bounds)?;
        let index = self.bounds.len();
        self.bounds.push(bounds);
        for cell_x in min_x..=max_x {
            for cell_y in min_y..=max_y {
                self.cells.entry((cell_x, cell_y)).or_default().push(index);
            }
        }
        Ok(())
    }

    fn collides(&self, bounds: CollisionBounds) -> anyhow::Result<bool> {
        let (min_x, min_y, max_x, max_y) = Self::cell_range(bounds)?;
        let mut candidates = Vec::<usize>::new();
        for cell_x in min_x..=max_x {
            for cell_y in min_y..=max_y {
                if let Some(indices) = self.cells.get(&(cell_x, cell_y)) {
                    candidates.extend_from_slice(indices);
                }
            }
        }
        candidates.sort_unstable();
        candidates.dedup();
        Ok(candidates
            .into_iter()
            .any(|index| bounds.collides(self.bounds[index])))
    }
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

fn valid_opaque_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_OPAQUE_ID_BYTES && !value.chars().any(char::is_control)
}

fn require_intent(command: &SimulationCommandPatch) -> anyhow::Result<LayoutIntent> {
    if command.top_level_changes.len() != 1
        || !command.changed_entities.is_empty()
        || !command.added_entities.is_empty()
        || !command.removed_entity_ids.is_empty()
        || !command.changed_belts.is_empty()
        || !command.added_belts.is_empty()
        || !command.removed_belt_ids.is_empty()
    {
        bail!("native player-authority factory layout intent shape is invalid");
    }
    let change = &command.top_level_changes[0];
    if !exact_intent_path(&change.path) || change.operation != "set" {
        bail!("native player-authority factory layout intent path is invalid");
    }
    let intent = change
        .value
        .as_ref()
        .and_then(Value::as_object)
        .filter(|intent| {
            intent.len() == 3
                && intent.contains_key("kind")
                && intent.contains_key("scope")
                && intent.contains_key("entityIds")
        })
        .ok_or_else(|| anyhow!("native player-authority factory layout intent is invalid"))?;
    if intent.get("kind").and_then(Value::as_str) != Some("apply") {
        bail!("native player-authority factory layout kind is invalid");
    }
    let scope = match intent.get("scope").and_then(Value::as_str) {
        Some("all") => LayoutScope::All,
        Some("selection") => LayoutScope::Selection,
        _ => bail!("native player-authority factory layout scope is invalid"),
    };
    let ids = intent
        .get("entityIds")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("native player-authority factory layout entity IDs are invalid"))?;
    if (scope == LayoutScope::All && !ids.is_empty())
        || (scope == LayoutScope::Selection && (ids.is_empty() || ids.len() > MAX_SELECTION_ROWS))
    {
        bail!("native player-authority factory layout entity ID count is invalid");
    }
    let mut seen = HashSet::<&str>::with_capacity(ids.len());
    let mut entity_ids = Vec::with_capacity(ids.len());
    for id in ids {
        let id = id
            .as_str()
            .filter(|id| valid_opaque_id(id))
            .ok_or_else(|| {
                anyhow!("native player-authority factory layout entity ID is invalid")
            })?;
        if !seen.insert(id) {
            bail!("native player-authority factory layout entity ID is repeated");
        }
        entity_ids.push(id.to_owned());
    }
    Ok(LayoutIntent { scope, entity_ids })
}

pub(crate) fn validate_resume_marker(command: &SimulationCommandPatch) -> anyhow::Result<()> {
    require_intent(command).map(|_| ())
}

fn collision_bounds(entity: &LayoutEntity, x: f64, y: f64) -> anyhow::Result<CollisionBounds> {
    let fixed_resource = entity.kind == "vein";
    let width = if fixed_resource {
        360.0
    } else {
        entity.layout_width
    };
    let height = if fixed_resource {
        300.0
    } else {
        entity.layout_height
    };
    let clearance = if fixed_resource {
        80.0
    } else {
        entity.layout_clearance
    };
    let bounds = CollisionBounds {
        left: x - clearance,
        top: y - clearance,
        right: x + width + clearance,
        bottom: y + height + clearance,
    };
    if [bounds.left, bounds.top, bounds.right, bounds.bottom]
        .iter()
        .any(|value| !value.is_finite())
    {
        bail!("native factory layout collision bounds overflowed");
    }
    Ok(bounds)
}

fn find_free_position(
    entity: &LayoutEntity,
    desired_x: f64,
    desired_y: f64,
    obstacles: &SpatialObstacles,
) -> anyhow::Result<(f64, f64)> {
    for row_offset in 0..MAX_ROW_OFFSETS {
        let y = desired_y + row_offset as f64 * ROW_GAP;
        if !desired_x.is_finite() || !y.is_finite() {
            bail!("native factory layout position overflowed");
        }
        let bounds = collision_bounds(entity, desired_x, y)?;
        if !obstacles.collides(bounds)? {
            return Ok((desired_x, y));
        }
    }
    let x = desired_x + COLUMN_GAP;
    let y = desired_y + MAX_ROW_OFFSETS as f64 * ROW_GAP;
    collision_bounds(entity, x, y)?;
    Ok((x, y))
}

fn load_active_planet_entities(
    state: &CoreState,
    intent: &LayoutIntent,
) -> anyhow::Result<(usize, Vec<LayoutEntity>, HashSet<String>)> {
    if !state.catalog.data_only_native_supported {
        bail!("native player-authority factory layout cannot execute scripted content packs");
    }
    let active_planet_id = state
        .base_value()
        .get("activePlanetId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            anyhow!("native player-authority factory layout active planet is invalid")
        })?;
    let planet_index = state
        .catalog
        .planets
        .iter()
        .position(|planet| planet.id == active_planet_id)
        .ok_or_else(|| {
            anyhow!("native player-authority factory layout active planet is unknown")
        })?;

    let requested = intent.entity_ids.iter().cloned().collect::<HashSet<_>>();
    if intent.scope == LayoutScope::Selection {
        for id in &intent.entity_ids {
            let index = *state.entity_index.get(id).ok_or_else(|| {
                anyhow!("native player-authority factory layout entity is missing")
            })?;
            if state
                .factory_topology
                .entity_planet_indices
                .get(index)
                .copied()
                != Some(planet_index)
            {
                bail!("native player-authority factory layout selection spans planets");
            }
        }
    }

    let rows = state
        .factory_topology
        .entities_by_planet
        .get(planet_index)
        .ok_or_else(|| {
            anyhow!("native player-authority factory layout planet topology is invalid")
        })?;
    let mut entities = Vec::with_capacity(rows.len());
    for compact_index in rows {
        let entity_index = usize::try_from(*compact_index)
            .map_err(|_| anyhow!("native factory layout entity index is invalid"))?;
        let value = state.parse_entity(entity_index)?;
        let object = value
            .as_object()
            .ok_or_else(|| anyhow!("native factory layout entity is invalid"))?;
        let id = object
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| valid_opaque_id(id))
            .ok_or_else(|| anyhow!("native factory layout entity ID is invalid"))?;
        if id != &state.entities.ids[entity_index] {
            bail!("native factory layout entity ID index drifted");
        }
        if object.get("planetId").and_then(Value::as_str) != Some(active_planet_id) {
            bail!("native factory layout entity planet index drifted");
        }
        let kind = object
            .get("kind")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("native factory layout entity kind is invalid"))?;
        let building_id = object
            .get("buildingId")
            .filter(|value| !value.is_null())
            .map(|value| {
                value
                    .as_str()
                    .filter(|id| valid_opaque_id(id))
                    .map(str::to_owned)
                    .ok_or_else(|| anyhow!("native factory layout building ID is invalid"))
            })
            .transpose()?;
        let resource_id = object
            .get("resourceId")
            .filter(|value| !value.is_null())
            .map(|value| {
                value
                    .as_str()
                    .filter(|id| valid_opaque_id(id))
                    .map(str::to_owned)
                    .ok_or_else(|| anyhow!("native factory layout resource ID is invalid"))
            })
            .transpose()?;
        let interaction_locked = match object.get("interactionLocked") {
            None | Some(Value::Bool(false)) => false,
            Some(Value::Bool(true)) => true,
            Some(_) => bail!("native factory layout interaction lock is invalid"),
        };
        let position = object
            .get("position")
            .and_then(Value::as_object)
            .filter(|position| {
                position.len() == 2 && position.contains_key("x") && position.contains_key("y")
            })
            .ok_or_else(|| anyhow!("native factory layout entity position is invalid"))?;
        let x = position
            .get("x")
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite())
            .ok_or_else(|| anyhow!("native factory layout entity X is invalid"))?;
        let y = position
            .get("y")
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite())
            .ok_or_else(|| anyhow!("native factory layout entity Y is invalid"))?;
        let metadata = building_id
            .as_deref()
            .and_then(|building_id| state.catalog.building_metadata.get(building_id));
        if building_id.is_some() && metadata.is_none() {
            bail!("native factory layout building metadata is missing")
        }
        entities.push(LayoutEntity {
            entity_index,
            id: id.to_owned(),
            kind: kind.to_owned(),
            sort_label: building_id
                .as_deref()
                .or(resource_id.as_deref())
                .unwrap_or_default()
                .to_owned(),
            interaction_locked,
            x,
            y,
            layout_width: metadata.map_or(300.0, |metadata| metadata.layout_width),
            layout_height: metadata.map_or(220.0, |metadata| metadata.layout_height),
            layout_clearance: metadata.map_or(24.0, |metadata| metadata.layout_clearance),
        });
    }
    Ok((planet_index, entities, requested))
}

fn plan_layout(state: &CoreState, intent: &LayoutIntent) -> anyhow::Result<Vec<LayoutMove>> {
    let (planet_index, all_entities, requested) = load_active_planet_entities(state, intent)?;
    let mut movable = all_entities
        .iter()
        .filter(|entity| {
            entity.kind != "vein"
                && !entity.interaction_locked
                && (intent.scope == LayoutScope::All || requested.contains(&entity.id))
        })
        .cloned()
        .collect::<Vec<_>>();
    if movable.is_empty() || movable.len() > MAX_MOVABLE_ROWS {
        bail!("native player-authority factory layout movable row count is invalid");
    }
    movable.sort_by(|left, right| left.order_key().cmp(&right.order_key()));

    let movable_by_id = movable
        .iter()
        .enumerate()
        .map(|(index, entity)| (entity.id.clone(), index))
        .collect::<HashMap<_, _>>();
    let movable_ids = movable_by_id.keys().cloned().collect::<HashSet<_>>();
    let mut incoming = vec![Vec::<usize>::new(); movable.len()];
    let mut outgoing = vec![Vec::<usize>::new(); movable.len()];
    for belt_index in 0..state.belts.ids.len() {
        if state.belts.planets[belt_index] != state.entities.planets[movable[0].entity_index] {
            continue;
        }
        let Some(target_id) = state.symbols.resolve(state.belts.targets[belt_index]) else {
            continue;
        };
        let Some(&target) = movable_by_id.get(target_id) else {
            continue;
        };
        let Some(source_id) = state.symbols.resolve(state.belts.sources[belt_index]) else {
            continue;
        };
        if let Some(&source) = movable_by_id.get(source_id) {
            incoming[target].push(source);
            outgoing[source].push(target);
        }
    }

    let mut indegree = incoming.iter().map(Vec::len).collect::<Vec<_>>();
    let mut ready = BTreeSet::<(u8, String, String, usize)>::new();
    for (index, entity) in movable.iter().enumerate() {
        if indegree[index] == 0 {
            let (rank, label, id) = entity.order_key();
            ready.insert((rank, label.to_owned(), id.to_owned(), index));
        }
    }
    let mut layers = vec![None::<usize>; movable.len()];
    while let Some(entry) = ready.pop_first() {
        let index = entry.3;
        let layer = incoming[index]
            .iter()
            .filter_map(|&source| layers[source])
            .map(|layer| layer.saturating_add(1))
            .max()
            .unwrap_or(0);
        layers[index] = Some(layer);
        for &target in &outgoing[index] {
            indegree[target] = indegree[target].saturating_sub(1);
            if indegree[target] == 0 {
                let entity = &movable[target];
                let (rank, label, id) = entity.order_key();
                ready.insert((rank, label.to_owned(), id.to_owned(), target));
            }
        }
    }
    let resolved_max = layers.iter().filter_map(|layer| *layer).max().unwrap_or(0);
    let mut unresolved_index = 0_usize;
    for layer in &mut layers {
        if layer.is_none() {
            *layer = Some(resolved_max + 1 + unresolved_index / 4);
            unresolved_index += 1;
        }
    }

    // JavaScript Math.round uses floor(x + 0.5), including negative halves.
    let js_grid_round = |value: f64| ((value / GRID_SIZE) + 0.5).floor() * GRID_SIZE;
    let origin_x = js_grid_round(
        movable
            .iter()
            .map(|entity| entity.x)
            .fold(f64::INFINITY, f64::min),
    );
    let origin_y = js_grid_round(
        movable
            .iter()
            .map(|entity| entity.y)
            .fold(f64::INFINITY, f64::min),
    );
    if !origin_x.is_finite() || !origin_y.is_finite() {
        bail!("native factory layout origin is invalid");
    }

    let mut columns = BTreeMap::<usize, Vec<usize>>::new();
    for (index, layer) in layers.into_iter().enumerate() {
        columns.entry(layer.unwrap_or(0)).or_default().push(index);
    }
    let mut obstacles = SpatialObstacles::default();
    for entity in all_entities
        .iter()
        .filter(|entity| !movable_ids.contains(&entity.id))
    {
        obstacles.insert(collision_bounds(entity, entity.x, entity.y)?)?;
    }

    let mut moves = Vec::with_capacity(movable.len());
    for (column, mut entries) in columns {
        entries.sort_by(|&left, &right| movable[left].order_key().cmp(&movable[right].order_key()));
        for (row, entity_index) in entries.into_iter().enumerate() {
            let entity = &movable[entity_index];
            let desired_x = origin_x + column as f64 * COLUMN_GAP;
            let desired_y = origin_y + row as f64 * ROW_GAP;
            let (x, y) = find_free_position(entity, desired_x, desired_y, &obstacles)?;
            obstacles.insert(collision_bounds(entity, x, y)?)?;
            moves.push(LayoutMove {
                entity_id: entity.id.clone(),
                before_x: entity.x,
                before_y: entity.y,
                after_x: x,
                after_y: y,
            });
        }
    }
    let _ = planet_index;
    Ok(moves)
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
    let mut changed_entities = Vec::new();
    for movement in plan_layout(state, &intent)? {
        let mut changes = Vec::with_capacity(2);
        if movement.before_x != movement.after_x {
            changes.push(ValuePatch {
                path: vec![
                    PathSegment::Key("position".to_owned()),
                    PathSegment::Key("x".to_owned()),
                ],
                operation: "set".to_owned(),
                value: Some(Value::from(movement.after_x)),
            });
        }
        if movement.before_y != movement.after_y {
            changes.push(ValuePatch {
                path: vec![
                    PathSegment::Key("position".to_owned()),
                    PathSegment::Key("y".to_owned()),
                ],
                operation: "set".to_owned(),
                value: Some(Value::from(movement.after_y)),
            });
        }
        if !changes.is_empty() {
            changed_entities.push(RecordPatch {
                id: movement.entity_id,
                changes,
            });
        }
    }
    if changed_entities.is_empty() {
        bail!("native player-authority factory layout is unchanged");
    }
    let expanded = SimulationCommandPatch {
        protocol_version: command.protocol_version,
        base_revision: command.base_revision,
        top_level_changes: Vec::new(),
        changed_entities,
        added_entities: Vec::new(),
        removed_entity_ids: Vec::new(),
        changed_belts: Vec::new(),
        added_belts: Vec::new(),
        removed_belt_ids: Vec::new(),
    };
    crate::command::validate_player_position_command(state, &expanded)?;
    Ok(expanded)
}
