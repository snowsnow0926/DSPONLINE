//! Durable semantic edits for Dyson shell plans and layers.
//!
//! The renderer sends only a compact operation marker. Rust validates the
//! complete authoritative plan, derives stable layer/node/frame/shell
//! identifiers from `nextId`, reconciles material allocation, and stores the
//! compact intent in the WAL. Cold replay therefore produces the same plan
//! without trusting renderer-authored structure arrays or material counters.

use std::collections::HashSet;

use anyhow::{anyhow, bail};
use serde_json::{Map, Value, json};

use crate::{
    command::{PathSegment, SimulationCommandPatch, ValuePatch, technology_is_completed},
    dyson::reconcile_plan,
    state::CoreState,
};

const INTENT_ROOT: &str = "dysonPlans";
const INTENT_LEAF: &str = "intent";
const MAX_OPAQUE_ID_BYTES: usize = 1_024;
const MAX_JAVASCRIPT_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_DYSON_LAYERS: usize = 8;
const MAX_DYSON_NODES_PER_LAYER: usize = 24;
const MAX_DYSON_FRAMES_PER_LAYER: usize = 576;
const MAX_DYSON_SHELLS_PER_LAYER: usize = 576;
const DYSON_SHELL_CAPACITY_PER_STRUCTURE: u64 = 40;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DysonPlanIntentKind {
    AddLayer,
    AddStandardLayer,
    SetLayerOrbit,
    RemoveLayer,
    AddNode,
    RemoveNode,
    ConnectNodes,
    AutoConnect,
    PlanShell,
    ClearShell,
}

#[derive(Clone, Copy, Debug, Default)]
struct DysonLayerOrbitChanges {
    radius: Option<u64>,
    inclination: Option<i64>,
    longitude: Option<f64>,
}

#[derive(Debug)]
struct DysonPlanIntent {
    kind: DysonPlanIntentKind,
    system_id: String,
    layer_id: Option<String>,
    orbit: DysonLayerOrbitChanges,
    angle: Option<f64>,
    node_id: Option<String>,
    source_node_id: Option<String>,
    target_node_id: Option<String>,
}

#[derive(Clone, Debug)]
struct OrderedNode {
    id: String,
    angle: f64,
    original_index: usize,
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

fn exact_object_keys(value: &Map<String, Value>, keys: &[&str]) -> bool {
    value.len() == keys.len() && keys.iter().all(|key| value.contains_key(*key))
}

fn require_intent(command: &SimulationCommandPatch) -> anyhow::Result<DysonPlanIntent> {
    if command.top_level_changes.len() != 1
        || !command.changed_entities.is_empty()
        || !command.added_entities.is_empty()
        || !command.removed_entity_ids.is_empty()
        || !command.changed_belts.is_empty()
        || !command.added_belts.is_empty()
        || !command.removed_belt_ids.is_empty()
    {
        bail!("native player-authority Dyson plan intent shape is invalid")
    }
    let change = &command.top_level_changes[0];
    if !exact_intent_path(&change.path) || change.operation != "set" {
        bail!("native player-authority Dyson plan intent path is invalid")
    }
    let intent = change
        .value
        .as_ref()
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native player-authority Dyson plan intent is invalid"))?;
    let kind = match intent.get("kind").and_then(Value::as_str) {
        Some("add-layer") => DysonPlanIntentKind::AddLayer,
        Some("add-standard-layer") => DysonPlanIntentKind::AddStandardLayer,
        Some("set-layer-orbit") => DysonPlanIntentKind::SetLayerOrbit,
        Some("remove-layer") => DysonPlanIntentKind::RemoveLayer,
        Some("add-node") => DysonPlanIntentKind::AddNode,
        Some("remove-node") => DysonPlanIntentKind::RemoveNode,
        Some("connect-nodes") => DysonPlanIntentKind::ConnectNodes,
        Some("auto-connect") => DysonPlanIntentKind::AutoConnect,
        Some("plan-shell") => DysonPlanIntentKind::PlanShell,
        Some("clear-shell") => DysonPlanIntentKind::ClearShell,
        _ => bail!("native player-authority Dyson plan intent kind is invalid"),
    };
    let expected_keys: &[&str] = match kind {
        DysonPlanIntentKind::AddLayer | DysonPlanIntentKind::AddStandardLayer => {
            &["kind", "systemId"]
        }
        DysonPlanIntentKind::SetLayerOrbit => &["kind", "systemId", "layerId", "changes"],
        DysonPlanIntentKind::AddNode => &["kind", "systemId", "layerId", "angle"],
        DysonPlanIntentKind::RemoveNode => &["kind", "systemId", "layerId", "nodeId"],
        DysonPlanIntentKind::ConnectNodes => &[
            "kind",
            "systemId",
            "layerId",
            "sourceNodeId",
            "targetNodeId",
        ],
        DysonPlanIntentKind::RemoveLayer
        | DysonPlanIntentKind::AutoConnect
        | DysonPlanIntentKind::PlanShell
        | DysonPlanIntentKind::ClearShell => &["kind", "systemId", "layerId"],
    };
    if !exact_object_keys(intent, expected_keys) {
        bail!("native player-authority Dyson plan intent fields are invalid")
    }
    let system_id = intent
        .get("systemId")
        .and_then(Value::as_str)
        .filter(|value| valid_opaque_id(value))
        .ok_or_else(|| anyhow!("native player-authority Dyson plan system ID is invalid"))?;
    let layer_id = if matches!(
        kind,
        DysonPlanIntentKind::AddLayer | DysonPlanIntentKind::AddStandardLayer
    ) {
        None
    } else {
        Some(
            intent
                .get("layerId")
                .and_then(Value::as_str)
                .filter(|value| valid_opaque_id(value))
                .ok_or_else(|| anyhow!("native player-authority Dyson plan layer ID is invalid"))?
                .to_owned(),
        )
    };
    let mut orbit = DysonLayerOrbitChanges::default();
    if kind == DysonPlanIntentKind::SetLayerOrbit {
        let changes = intent
            .get("changes")
            .and_then(Value::as_object)
            .filter(|changes| {
                !changes.is_empty()
                    && changes.len() <= 3
                    && changes
                        .keys()
                        .all(|key| matches!(key.as_str(), "radius" | "inclination" | "longitude"))
            })
            .ok_or_else(|| {
                anyhow!("native player-authority Dyson layer orbit changes are invalid")
            })?;
        if let Some(value) = changes.get("radius") {
            let radius = positive_integer(Some(value), "layer radius")?;
            if !(5_000..=50_000).contains(&radius) {
                bail!("native player-authority Dyson layer radius is outside its canonical range")
            }
            orbit.radius = Some(radius);
        }
        if let Some(value) = changes.get("inclination") {
            let inclination = value
                .as_f64()
                .filter(|value| {
                    value.is_finite() && value.fract() == 0.0 && (-90.0..=90.0).contains(value)
                })
                .ok_or_else(|| {
                    anyhow!("native player-authority Dyson layer inclination is invalid")
                })?;
            orbit.inclination = Some(inclination as i64);
        }
        if let Some(value) = changes.get("longitude") {
            orbit.longitude = Some(canonical_angle(Some(value), "layer longitude")?);
        }
    }
    let angle = if kind == DysonPlanIntentKind::AddNode {
        Some(canonical_angle(intent.get("angle"), "node angle")?)
    } else {
        None
    };
    let node_id = if kind == DysonPlanIntentKind::RemoveNode {
        Some(
            intent
                .get("nodeId")
                .and_then(Value::as_str)
                .filter(|value| valid_opaque_id(value))
                .ok_or_else(|| anyhow!("native player-authority Dyson node ID is invalid"))?
                .to_owned(),
        )
    } else {
        None
    };
    let command_node_id = |key: &str, label: &str| {
        intent
            .get(key)
            .and_then(Value::as_str)
            .filter(|value| valid_opaque_id(value))
            .map(str::to_owned)
            .ok_or_else(|| anyhow!("native player-authority Dyson {label} is invalid"))
    };
    let (source_node_id, target_node_id) = if kind == DysonPlanIntentKind::ConnectNodes {
        (
            Some(command_node_id("sourceNodeId", "source node ID")?),
            Some(command_node_id("targetNodeId", "target node ID")?),
        )
    } else {
        (None, None)
    };
    Ok(DysonPlanIntent {
        kind,
        system_id: system_id.to_owned(),
        layer_id,
        orbit,
        angle,
        node_id,
        source_node_id,
        target_node_id,
    })
}

fn safe_integer(value: Option<&Value>, label: &str) -> anyhow::Result<u64> {
    let value = value
        .and_then(Value::as_f64)
        .filter(|value| {
            value.is_finite()
                && *value >= 0.0
                && *value <= MAX_JAVASCRIPT_SAFE_INTEGER as f64
                && value.fract() == 0.0
        })
        .ok_or_else(|| anyhow!("native player-authority Dyson {label} is invalid"))?;
    Ok(value as u64)
}

fn positive_integer(value: Option<&Value>, label: &str) -> anyhow::Result<u64> {
    safe_integer(value, label).and_then(|value| {
        if value == 0 {
            bail!("native player-authority Dyson {label} is invalid")
        }
        Ok(value)
    })
}

fn canonical_angle(value: Option<&Value>, label: &str) -> anyhow::Result<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|value| {
            value.is_finite()
                && (0.0..360.0).contains(value)
                && (value * 10.0 - (value * 10.0).round()).abs() < 1e-9
        })
        .ok_or_else(|| anyhow!("native player-authority Dyson {label} is invalid"))
}

fn require_id<'a>(value: Option<&'a Value>, label: &str) -> anyhow::Result<&'a str> {
    value
        .and_then(Value::as_str)
        .filter(|value| valid_opaque_id(value))
        .ok_or_else(|| anyhow!("native player-authority Dyson {label} is invalid"))
}

fn undirected_edge(source: &str, target: &str) -> (String, String) {
    if source <= target {
        (source.to_owned(), target.to_owned())
    } else {
        (target.to_owned(), source.to_owned())
    }
}

fn frame_exists(frames: &[Value], source: &str, target: &str) -> bool {
    frames.iter().filter_map(Value::as_object).any(|frame| {
        let frame_source = frame.get("sourceNodeId").and_then(Value::as_str);
        let frame_target = frame.get("targetNodeId").and_then(Value::as_str);
        (frame_source == Some(source) && frame_target == Some(target))
            || (frame_source == Some(target) && frame_target == Some(source))
    })
}

fn shell_exists(shells: &[Value], source: &str, target: &str) -> bool {
    shells.iter().filter_map(Value::as_object).any(|shell| {
        let shell_source = shell.get("sourceNodeId").and_then(Value::as_str);
        let shell_target = shell.get("targetNodeId").and_then(Value::as_str);
        (shell_source == Some(source) && shell_target == Some(target))
            || (shell_source == Some(target) && shell_target == Some(source))
    })
}

fn frame_requirement(radius: u64, source_angle: f64, target_angle: f64) -> u64 {
    let direct = (source_angle - target_angle).abs() % 360.0;
    let arc = direct.min(360.0 - direct);
    ((radius as f64 / 10_000.0 * arc / 45.0).ceil() as u64).max(1)
}

fn validate_layer(
    layer: &Map<String, Value>,
    all_ids: &mut HashSet<String>,
) -> anyhow::Result<Vec<OrderedNode>> {
    let layer_id = require_id(layer.get("id"), "layer ID")?;
    if !all_ids.insert(layer_id.to_owned()) {
        bail!("native player-authority Dyson design ID is duplicated")
    }
    let radius = positive_integer(layer.get("radius"), "layer radius")?;
    if !(5_000..=50_000).contains(&radius) {
        bail!("native player-authority Dyson layer radius is outside its canonical range")
    }
    let inclination = layer
        .get("inclination")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && value.fract() == 0.0 && (-90.0..=90.0).contains(value))
        .ok_or_else(|| anyhow!("native player-authority Dyson layer inclination is invalid"))?;
    let _ = inclination;
    canonical_angle(layer.get("longitude"), "layer longitude")?;
    safe_integer(
        layer.get("structureAllocationFloor"),
        "structure allocation floor",
    )?;
    safe_integer(layer.get("shellAllocationFloor"), "shell allocation floor")?;

    let nodes = layer
        .get("nodes")
        .and_then(Value::as_array)
        .filter(|nodes| nodes.len() <= MAX_DYSON_NODES_PER_LAYER)
        .ok_or_else(|| anyhow!("native player-authority Dyson node directory is invalid"))?;
    let mut ordered_nodes = Vec::with_capacity(nodes.len());
    let mut node_ids = HashSet::with_capacity(nodes.len());
    for (index, node) in nodes.iter().enumerate() {
        let node = node
            .as_object()
            .ok_or_else(|| anyhow!("native player-authority Dyson node is invalid"))?;
        let id = require_id(node.get("id"), "node ID")?;
        if !node_ids.insert(id.to_owned()) || !all_ids.insert(id.to_owned()) {
            bail!("native player-authority Dyson node ID is duplicated")
        }
        let angle = canonical_angle(node.get("angle"), "node angle")?;
        let required = positive_integer(node.get("requiredStructurePoints"), "node requirement")?;
        let completed = safe_integer(node.get("completedStructurePoints"), "node completion")?;
        if completed > required {
            bail!("native player-authority Dyson node completion exceeds its requirement")
        }
        ordered_nodes.push(OrderedNode {
            id: id.to_owned(),
            angle,
            original_index: index,
        });
    }

    let frames = layer
        .get("frames")
        .and_then(Value::as_array)
        .filter(|frames| frames.len() <= MAX_DYSON_FRAMES_PER_LAYER)
        .ok_or_else(|| anyhow!("native player-authority Dyson frame directory is invalid"))?;
    let mut frame_ids = HashSet::with_capacity(frames.len());
    let mut frame_edges = HashSet::with_capacity(frames.len());
    for frame in frames {
        let frame = frame
            .as_object()
            .ok_or_else(|| anyhow!("native player-authority Dyson frame is invalid"))?;
        let id = require_id(frame.get("id"), "frame ID")?;
        let source = require_id(frame.get("sourceNodeId"), "frame source node ID")?;
        let target = require_id(frame.get("targetNodeId"), "frame target node ID")?;
        if source == target || !node_ids.contains(source) || !node_ids.contains(target) {
            bail!("native player-authority Dyson frame endpoints are invalid")
        }
        if !frame_ids.insert(id.to_owned())
            || !all_ids.insert(id.to_owned())
            || !frame_edges.insert(undirected_edge(source, target))
        {
            bail!("native player-authority Dyson frame ID or edge is duplicated")
        }
        let required = positive_integer(frame.get("requiredStructurePoints"), "frame requirement")?;
        let completed = safe_integer(frame.get("completedStructurePoints"), "frame completion")?;
        if completed > required {
            bail!("native player-authority Dyson frame completion exceeds its requirement")
        }
    }

    let shells = layer
        .get("shells")
        .and_then(Value::as_array)
        .filter(|shells| shells.len() <= MAX_DYSON_SHELLS_PER_LAYER)
        .ok_or_else(|| anyhow!("native player-authority Dyson shell directory is invalid"))?;
    let mut shell_edges = HashSet::with_capacity(shells.len());
    for shell in shells {
        let shell = shell
            .as_object()
            .ok_or_else(|| anyhow!("native player-authority Dyson shell is invalid"))?;
        let id = require_id(shell.get("id"), "shell ID")?;
        let source = require_id(shell.get("sourceNodeId"), "shell source node ID")?;
        let target = require_id(shell.get("targetNodeId"), "shell target node ID")?;
        if source == target || !node_ids.contains(source) || !node_ids.contains(target) {
            bail!("native player-authority Dyson shell endpoints are invalid")
        }
        if !all_ids.insert(id.to_owned()) || !shell_edges.insert(undirected_edge(source, target)) {
            bail!("native player-authority Dyson shell ID or edge is duplicated")
        }
        let boundaries = shell
            .get("boundaryFrameIds")
            .and_then(Value::as_array)
            .filter(|boundaries| !boundaries.is_empty() && boundaries.len() <= frames.len())
            .ok_or_else(|| anyhow!("native player-authority Dyson shell boundary is invalid"))?;
        let mut boundary_ids = HashSet::with_capacity(boundaries.len());
        for boundary in boundaries {
            let boundary = require_id(Some(boundary), "shell boundary frame ID")?;
            if !frame_ids.contains(boundary) || !boundary_ids.insert(boundary) {
                bail!("native player-authority Dyson shell boundary is missing or duplicated")
            }
        }
        let capacity = positive_integer(shell.get("sailCapacity"), "shell capacity")?;
        let absorbed = safe_integer(shell.get("absorbedSails"), "absorbed shell sails")?;
        if absorbed > capacity {
            bail!("native player-authority Dyson absorbed sails exceed shell capacity")
        }
    }
    Ok(ordered_nodes)
}

fn validate_plan(
    plan: &Map<String, Value>,
) -> anyhow::Result<(Vec<Vec<OrderedNode>>, HashSet<String>)> {
    safe_integer(plan.get("structurePoints"), "plan structure points")?;
    safe_integer(plan.get("shellSails"), "plan shell sails")?;
    let layers = plan
        .get("layers")
        .and_then(Value::as_array)
        .filter(|layers| layers.len() <= MAX_DYSON_LAYERS)
        .ok_or_else(|| anyhow!("native player-authority Dyson layer directory is invalid"))?;
    let mut all_ids = HashSet::new();
    let mut nodes_by_layer = Vec::with_capacity(layers.len());
    for layer in layers {
        let layer = layer
            .as_object()
            .ok_or_else(|| anyhow!("native player-authority Dyson layer is invalid"))?;
        let nodes = validate_layer(layer, &mut all_ids)?;
        nodes_by_layer.push(nodes);
    }
    if let Some(active_layer_id) = plan.get("activeLayerId").filter(|value| !value.is_null()) {
        let active_layer_id = require_id(Some(active_layer_id), "active layer ID")?;
        if !layers
            .iter()
            .any(|layer| layer.get("id").and_then(Value::as_str) == Some(active_layer_id))
        {
            bail!("native player-authority Dyson active layer is missing")
        }
    } else if !plan.get("activeLayerId").is_some_and(Value::is_null) {
        bail!("native player-authority Dyson active layer is invalid")
    }
    Ok((nodes_by_layer, all_ids))
}

fn target_layer(
    plan: &Map<String, Value>,
    nodes_by_layer: &[Vec<OrderedNode>],
    target_layer_id: &str,
) -> anyhow::Result<(usize, Vec<OrderedNode>)> {
    let layers = plan
        .get("layers")
        .and_then(Value::as_array)
        .expect("Dyson plan layer directory was validated");
    let index = layers
        .iter()
        .position(|layer| layer.get("id").and_then(Value::as_str) == Some(target_layer_id))
        .ok_or_else(|| anyhow!("native player-authority Dyson target layer is missing"))?;
    let mut nodes = nodes_by_layer[index].clone();
    nodes.sort_by(|left, right| {
        left.angle
            .total_cmp(&right.angle)
            .then(left.original_index.cmp(&right.original_index))
    });
    Ok((index, nodes))
}

fn allocate_id(
    prefix: &str,
    next_id: &mut u64,
    all_ids: &mut HashSet<String>,
) -> anyhow::Result<String> {
    let following = next_id
        .checked_add(1)
        .filter(|value| *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
        .ok_or_else(|| anyhow!("native player-authority Dyson next ID overflows"))?;
    let id = format!("{prefix}_{}", *next_id);
    if !all_ids.insert(id.clone()) {
        bail!("native player-authority Dyson generated ID collides with existing design")
    }
    *next_id = following;
    Ok(id)
}

fn add_missing_frames(
    layer: &mut Map<String, Value>,
    nodes: &[OrderedNode],
    next_id: &mut u64,
    all_ids: &mut HashSet<String>,
) -> anyhow::Result<usize> {
    let radius = positive_integer(layer.get("radius"), "layer radius")?;
    let frames = layer
        .get_mut("frames")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| anyhow!("native player-authority Dyson frame directory is invalid"))?;
    let mut added = 0;
    for index in 0..nodes.len() {
        let source = &nodes[index];
        let target = &nodes[(index + 1) % nodes.len()];
        if frame_exists(frames, &source.id, &target.id) {
            continue;
        }
        if frames.len() >= MAX_DYSON_FRAMES_PER_LAYER {
            bail!("native player-authority Dyson frame limit is exceeded")
        }
        let id = allocate_id("dyson_frame", next_id, all_ids)?;
        frames.push(json!({
            "id": id,
            "sourceNodeId": source.id,
            "targetNodeId": target.id,
            "requiredStructurePoints": frame_requirement(radius, source.angle, target.angle),
            "completedStructurePoints": 0,
        }));
        added += 1;
    }
    Ok(added)
}

fn add_missing_shells(
    layer: &mut Map<String, Value>,
    nodes: &[OrderedNode],
    next_id: &mut u64,
    all_ids: &mut HashSet<String>,
) -> anyhow::Result<usize> {
    let frames = layer
        .get("frames")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("native player-authority Dyson frame directory is invalid"))?;
    let new_shells = {
        let shells = layer
            .get("shells")
            .and_then(Value::as_array)
            .ok_or_else(|| anyhow!("native player-authority Dyson shell directory is invalid"))?;
        let mut additions = Vec::new();
        for index in 0..nodes.len() {
            let source = &nodes[index];
            let target = &nodes[(index + 1) % nodes.len()];
            if shell_exists(shells, &source.id, &target.id) {
                continue;
            }
            let frame = frames
                .iter()
                .filter_map(Value::as_object)
                .find(|frame| {
                    let frame_source = frame.get("sourceNodeId").and_then(Value::as_str);
                    let frame_target = frame.get("targetNodeId").and_then(Value::as_str);
                    (frame_source == Some(&source.id) && frame_target == Some(&target.id))
                        || (frame_source == Some(&target.id) && frame_target == Some(&source.id))
                })
                .ok_or_else(|| {
                    anyhow!("native player-authority Dyson shell boundary frame is missing")
                })?;
            let frame_id = require_id(frame.get("id"), "shell boundary frame ID")?;
            let required =
                positive_integer(frame.get("requiredStructurePoints"), "frame requirement")?;
            let sail_capacity = required
                .checked_mul(DYSON_SHELL_CAPACITY_PER_STRUCTURE)
                .filter(|value| *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
                .ok_or_else(|| anyhow!("native player-authority Dyson shell capacity overflows"))?;
            additions.push((
                source.id.clone(),
                target.id.clone(),
                frame_id.to_owned(),
                sail_capacity,
            ));
        }
        additions
    };
    let shells = layer
        .get_mut("shells")
        .and_then(Value::as_array_mut)
        .expect("Dyson shell directory was validated");
    if shells.len().saturating_add(new_shells.len()) > MAX_DYSON_SHELLS_PER_LAYER {
        bail!("native player-authority Dyson shell limit is exceeded")
    }
    let added = new_shells.len();
    for (source, target, frame_id, sail_capacity) in new_shells {
        let id = allocate_id("dyson_shell", next_id, all_ids)?;
        shells.push(json!({
            "id": id,
            "sourceNodeId": source,
            "targetNodeId": target,
            "boundaryFrameIds": [frame_id],
            "sailCapacity": sail_capacity,
            "absorbedSails": 0,
        }));
    }
    Ok(added)
}

fn append_layer(
    plan: &mut Map<String, Value>,
    standard: bool,
    shell_ready: bool,
    next_id: &mut u64,
    all_ids: &mut HashSet<String>,
) -> anyhow::Result<()> {
    let layer_count = plan
        .get("layers")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("native player-authority Dyson layer directory is invalid"))?
        .len();
    if layer_count >= MAX_DYSON_LAYERS {
        bail!("native player-authority Dyson layer limit is exceeded")
    }
    let layer_id = allocate_id("dyson_layer", next_id, all_ids)?;
    let radius = 10_000_u64 + layer_count as u64 * 4_000;
    let mut layer = json!({
        "id": layer_id,
        "name": if standard {
            format!("标准壳层 {}", layer_count + 1)
        } else {
            format!("壳层 {}", layer_count + 1)
        },
        "radius": radius,
        "inclination": if standard && layer_count % 2 == 1 { 18 } else { 0 },
        "longitude": if standard { layer_count * 24 % 360 } else { 0 },
        "nodes": [],
        "frames": [],
        "shells": [],
        "structureAllocationFloor": 0,
        "shellAllocationFloor": 0,
    })
    .as_object()
    .expect("new Dyson layer is an object")
    .clone();
    if standard {
        let mut ordered_nodes = Vec::with_capacity(8);
        let nodes = layer
            .get_mut("nodes")
            .and_then(Value::as_array_mut)
            .expect("new Dyson node directory is an array");
        for index in 0..8 {
            let id = allocate_id("dyson_node", next_id, all_ids)?;
            let angle = index as f64 * 45.0;
            nodes.push(json!({
                "id": id,
                "angle": angle,
                "requiredStructurePoints": 1,
                "completedStructurePoints": 0,
            }));
            ordered_nodes.push(OrderedNode {
                id,
                angle,
                original_index: index,
            });
        }
        add_missing_frames(&mut layer, &ordered_nodes, next_id, all_ids)?;
        if shell_ready {
            add_missing_shells(&mut layer, &ordered_nodes, next_id, all_ids)?;
        }
    }
    plan.get_mut("layers")
        .and_then(Value::as_array_mut)
        .expect("Dyson layer directory was validated")
        .push(Value::Object(layer));
    plan.insert("activeLayerId".to_owned(), Value::from(layer_id));
    Ok(())
}

fn update_layer_orbit(
    layer: &mut Map<String, Value>,
    changes: DysonLayerOrbitChanges,
) -> anyhow::Result<bool> {
    let mut changed = false;
    if let Some(radius) = changes.radius
        && safe_integer(layer.get("radius"), "layer radius")? != radius
    {
        layer.insert("radius".to_owned(), Value::from(radius));
        changed = true;
    }
    if let Some(inclination) = changes.inclination
        && layer.get("inclination").and_then(Value::as_i64) != Some(inclination)
    {
        layer.insert("inclination".to_owned(), Value::from(inclination));
        changed = true;
    }
    if let Some(longitude) = changes.longitude
        && layer
            .get("longitude")
            .and_then(Value::as_f64)
            .is_none_or(|current| (current - longitude).abs() > 1e-9)
    {
        layer.insert("longitude".to_owned(), Value::from(longitude));
        changed = true;
    }
    if !changed {
        return Ok(false);
    }

    let radius = positive_integer(layer.get("radius"), "layer radius")?;
    let nodes = layer
        .get("nodes")
        .and_then(Value::as_array)
        .expect("Dyson nodes were validated")
        .iter()
        .filter_map(Value::as_object)
        .map(|node| {
            Ok((
                require_id(node.get("id"), "node ID")?.to_owned(),
                canonical_angle(node.get("angle"), "node angle")?,
            ))
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    let frames = layer
        .get_mut("frames")
        .and_then(Value::as_array_mut)
        .expect("Dyson frames were validated");
    for frame in frames.iter_mut().filter_map(Value::as_object_mut) {
        let source_id = require_id(frame.get("sourceNodeId"), "frame source node ID")?;
        let target_id = require_id(frame.get("targetNodeId"), "frame target node ID")?;
        let source_angle = nodes
            .iter()
            .find(|(id, _)| id == source_id)
            .map(|(_, angle)| *angle)
            .ok_or_else(|| anyhow!("native player-authority Dyson frame source node is missing"))?;
        let target_angle = nodes
            .iter()
            .find(|(id, _)| id == target_id)
            .map(|(_, angle)| *angle)
            .ok_or_else(|| anyhow!("native player-authority Dyson frame target node is missing"))?;
        frame.insert(
            "requiredStructurePoints".to_owned(),
            Value::from(frame_requirement(radius, source_angle, target_angle)),
        );
    }
    let frame_requirements = layer
        .get("frames")
        .and_then(Value::as_array)
        .expect("Dyson frames were validated")
        .iter()
        .filter_map(Value::as_object)
        .map(|frame| {
            Ok((
                require_id(frame.get("id"), "frame ID")?.to_owned(),
                positive_integer(frame.get("requiredStructurePoints"), "frame requirement")?,
            ))
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    let shells = layer
        .get_mut("shells")
        .and_then(Value::as_array_mut)
        .expect("Dyson shells were validated");
    for shell in shells.iter_mut().filter_map(Value::as_object_mut) {
        let boundary_id = shell
            .get("boundaryFrameIds")
            .and_then(Value::as_array)
            .and_then(|boundaries| boundaries.first())
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("native player-authority Dyson shell boundary is invalid"))?;
        let required = frame_requirements
            .iter()
            .find(|(id, _)| id == boundary_id)
            .map(|(_, required)| *required)
            .ok_or_else(|| anyhow!("native player-authority Dyson shell boundary is missing"))?;
        let capacity = required
            .checked_mul(DYSON_SHELL_CAPACITY_PER_STRUCTURE)
            .filter(|value| *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
            .ok_or_else(|| anyhow!("native player-authority Dyson shell capacity overflows"))?;
        shell.insert("sailCapacity".to_owned(), Value::from(capacity));
    }
    Ok(true)
}

fn shortest_angle_distance(left: f64, right: f64) -> f64 {
    let direct = (left - right).abs() % 360.0;
    direct.min(360.0 - direct)
}

fn append_node(
    layer: &mut Map<String, Value>,
    angle: f64,
    next_id: &mut u64,
    all_ids: &mut HashSet<String>,
) -> anyhow::Result<()> {
    let nodes = layer
        .get_mut("nodes")
        .and_then(Value::as_array_mut)
        .expect("Dyson nodes were validated");
    if nodes.len() >= MAX_DYSON_NODES_PER_LAYER {
        bail!("native player-authority Dyson node limit is exceeded")
    }
    if nodes.iter().filter_map(Value::as_object).any(|node| {
        canonical_angle(node.get("angle"), "node angle")
            .is_ok_and(|current| shortest_angle_distance(current, angle) < 5.0)
    }) {
        bail!("native player-authority Dyson node is too close to an existing node")
    }
    let id = allocate_id("dyson_node", next_id, all_ids)?;
    nodes.push(json!({
        "id": id,
        "angle": angle,
        "requiredStructurePoints": 1,
        "completedStructurePoints": 0,
    }));
    Ok(())
}

fn remove_node(layer: &mut Map<String, Value>, node_id: &str) -> anyhow::Result<()> {
    let node_exists = layer
        .get("nodes")
        .and_then(Value::as_array)
        .expect("Dyson nodes were validated")
        .iter()
        .any(|node| node.get("id").and_then(Value::as_str) == Some(node_id));
    if !node_exists {
        bail!("native player-authority Dyson node target is missing")
    }
    let removed_frame_ids = layer
        .get("frames")
        .and_then(Value::as_array)
        .expect("Dyson frames were validated")
        .iter()
        .filter_map(Value::as_object)
        .filter(|frame| {
            frame.get("sourceNodeId").and_then(Value::as_str) == Some(node_id)
                || frame.get("targetNodeId").and_then(Value::as_str) == Some(node_id)
        })
        .filter_map(|frame| frame.get("id").and_then(Value::as_str).map(str::to_owned))
        .collect::<HashSet<_>>();
    layer
        .get_mut("nodes")
        .and_then(Value::as_array_mut)
        .expect("Dyson nodes were validated")
        .retain(|node| node.get("id").and_then(Value::as_str) != Some(node_id));
    layer
        .get_mut("frames")
        .and_then(Value::as_array_mut)
        .expect("Dyson frames were validated")
        .retain(|frame| {
            frame
                .get("id")
                .and_then(Value::as_str)
                .is_none_or(|id| !removed_frame_ids.contains(id))
        });
    layer
        .get_mut("shells")
        .and_then(Value::as_array_mut)
        .expect("Dyson shells were validated")
        .retain(|shell| {
            shell.get("sourceNodeId").and_then(Value::as_str) != Some(node_id)
                && shell.get("targetNodeId").and_then(Value::as_str) != Some(node_id)
                && !shell
                    .get("boundaryFrameIds")
                    .and_then(Value::as_array)
                    .is_some_and(|boundaries| {
                        boundaries.iter().any(|boundary| {
                            boundary
                                .as_str()
                                .is_some_and(|id| removed_frame_ids.contains(id))
                        })
                    })
        });
    Ok(())
}

fn connect_nodes(
    layer: &mut Map<String, Value>,
    source_node_id: &str,
    target_node_id: &str,
    next_id: &mut u64,
    all_ids: &mut HashSet<String>,
) -> anyhow::Result<()> {
    if source_node_id == target_node_id {
        bail!("native player-authority Dyson frame endpoints are identical")
    }
    let nodes = layer
        .get("nodes")
        .and_then(Value::as_array)
        .expect("Dyson nodes were validated");
    let node_angle = |id: &str| {
        nodes
            .iter()
            .find(|node| node.get("id").and_then(Value::as_str) == Some(id))
            .and_then(Value::as_object)
            .map(|node| canonical_angle(node.get("angle"), "node angle"))
            .transpose()
    };
    let source_angle = node_angle(source_node_id)?
        .ok_or_else(|| anyhow!("native player-authority Dyson frame source node is missing"))?;
    let target_angle = node_angle(target_node_id)?
        .ok_or_else(|| anyhow!("native player-authority Dyson frame target node is missing"))?;
    let radius = positive_integer(layer.get("radius"), "layer radius")?;
    let frames = layer
        .get_mut("frames")
        .and_then(Value::as_array_mut)
        .expect("Dyson frames were validated");
    if frame_exists(frames, source_node_id, target_node_id) {
        bail!("native player-authority Dyson frame already exists")
    }
    if frames.len() >= MAX_DYSON_FRAMES_PER_LAYER {
        bail!("native player-authority Dyson frame limit is exceeded")
    }
    let id = allocate_id("dyson_frame", next_id, all_ids)?;
    frames.push(json!({
        "id": id,
        "sourceNodeId": source_node_id,
        "targetNodeId": target_node_id,
        "requiredStructurePoints": frame_requirement(radius, source_angle, target_angle),
        "completedStructurePoints": 0,
    }));
    Ok(())
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
    if !state
        .catalog
        .planets
        .iter()
        .any(|planet| planet.system_id == intent.system_id)
    {
        bail!("native player-authority Dyson plan system is unknown")
    }
    let exploration = state
        .base_value()
        .get("exploration")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native player-authority Dyson exploration state is invalid"))?;
    if !exploration
        .get("unlockedSystemIds")
        .and_then(Value::as_array)
        .is_some_and(|systems| {
            systems
                .iter()
                .any(|system| system.as_str() == Some(&intent.system_id))
        })
        || !technology_is_completed(state, "dyson_sphere_program")
    {
        bail!("native player-authority Dyson plan system or technology is locked")
    }
    if intent.kind == DysonPlanIntentKind::PlanShell
        && !technology_is_completed(state, "dyson_shell")
    {
        bail!("native player-authority Dyson shell technology is locked")
    }
    let plans = state
        .base_value()
        .get("dysonPlans")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native player-authority Dyson plan directory is missing"))?;
    let original_plan = plans
        .get(&intent.system_id)
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native player-authority Dyson plan is missing"))?;
    let (nodes_by_layer, mut all_ids) = validate_plan(original_plan)?;
    for (system_id, plan) in plans {
        if system_id == &intent.system_id {
            continue;
        }
        let (_, design_ids) = validate_plan(
            plan.as_object()
                .ok_or_else(|| anyhow!("native player-authority Dyson plan is invalid"))?,
        )?;
        for id in design_ids {
            if !all_ids.insert(id) {
                bail!("native player-authority Dyson design ID is duplicated across systems")
            }
        }
    }
    let mut candidate_plan = original_plan.clone();
    let mut next_id = safe_integer(state.base_value().get("nextId"), "next ID")?;
    let original_next_id = next_id;
    let changed = match intent.kind {
        DysonPlanIntentKind::AddLayer => {
            append_layer(
                &mut candidate_plan,
                false,
                false,
                &mut next_id,
                &mut all_ids,
            )?;
            true
        }
        DysonPlanIntentKind::AddStandardLayer => {
            append_layer(
                &mut candidate_plan,
                true,
                technology_is_completed(state, "dyson_shell"),
                &mut next_id,
                &mut all_ids,
            )?;
            true
        }
        DysonPlanIntentKind::SetLayerOrbit => {
            let layer_id = intent
                .layer_id
                .as_deref()
                .expect("layer orbit intent has a validated layer ID");
            let (layer_index, _) = target_layer(original_plan, &nodes_by_layer, layer_id)?;
            let layer = candidate_plan
                .get_mut("layers")
                .and_then(Value::as_array_mut)
                .and_then(|layers| layers.get_mut(layer_index))
                .and_then(Value::as_object_mut)
                .expect("Dyson plan and target layer were validated");
            update_layer_orbit(layer, intent.orbit)?
        }
        DysonPlanIntentKind::RemoveLayer => {
            let layer_id = intent
                .layer_id
                .as_deref()
                .expect("remove layer intent has a validated layer ID");
            target_layer(original_plan, &nodes_by_layer, layer_id)?;
            let removing_active =
                candidate_plan.get("activeLayerId").and_then(Value::as_str) == Some(layer_id);
            let fallback = {
                let layers = candidate_plan
                    .get_mut("layers")
                    .and_then(Value::as_array_mut)
                    .expect("Dyson plan layer directory was validated");
                layers.retain(|layer| layer.get("id").and_then(Value::as_str) != Some(layer_id));
                layers
                    .first()
                    .and_then(|layer| layer.get("id"))
                    .cloned()
                    .unwrap_or(Value::Null)
            };
            if removing_active {
                candidate_plan.insert("activeLayerId".to_owned(), fallback);
            }
            true
        }
        DysonPlanIntentKind::AddNode => {
            let layer_id = intent
                .layer_id
                .as_deref()
                .expect("add-node intent has a validated layer ID");
            let (layer_index, _) = target_layer(original_plan, &nodes_by_layer, layer_id)?;
            let layer = candidate_plan
                .get_mut("layers")
                .and_then(Value::as_array_mut)
                .and_then(|layers| layers.get_mut(layer_index))
                .and_then(Value::as_object_mut)
                .expect("Dyson plan and target layer were validated");
            append_node(
                layer,
                intent.angle.expect("add-node intent has a validated angle"),
                &mut next_id,
                &mut all_ids,
            )?;
            true
        }
        DysonPlanIntentKind::RemoveNode => {
            let layer_id = intent
                .layer_id
                .as_deref()
                .expect("remove-node intent has a validated layer ID");
            let (layer_index, _) = target_layer(original_plan, &nodes_by_layer, layer_id)?;
            let layer = candidate_plan
                .get_mut("layers")
                .and_then(Value::as_array_mut)
                .and_then(|layers| layers.get_mut(layer_index))
                .and_then(Value::as_object_mut)
                .expect("Dyson plan and target layer were validated");
            remove_node(
                layer,
                intent
                    .node_id
                    .as_deref()
                    .expect("remove-node intent has a validated node ID"),
            )?;
            true
        }
        DysonPlanIntentKind::ConnectNodes => {
            let layer_id = intent
                .layer_id
                .as_deref()
                .expect("connect-nodes intent has a validated layer ID");
            let (layer_index, _) = target_layer(original_plan, &nodes_by_layer, layer_id)?;
            let layer = candidate_plan
                .get_mut("layers")
                .and_then(Value::as_array_mut)
                .and_then(|layers| layers.get_mut(layer_index))
                .and_then(Value::as_object_mut)
                .expect("Dyson plan and target layer were validated");
            connect_nodes(
                layer,
                intent
                    .source_node_id
                    .as_deref()
                    .expect("connect-nodes intent has a validated source node ID"),
                intent
                    .target_node_id
                    .as_deref()
                    .expect("connect-nodes intent has a validated target node ID"),
                &mut next_id,
                &mut all_ids,
            )?;
            true
        }
        DysonPlanIntentKind::AutoConnect => {
            let layer_id = intent
                .layer_id
                .as_deref()
                .expect("auto-connect intent has a validated layer ID");
            let (layer_index, nodes) = target_layer(original_plan, &nodes_by_layer, layer_id)?;
            if nodes.len() < 3 {
                bail!("native player-authority Dyson layer needs at least three nodes")
            }
            let layer = candidate_plan
                .get_mut("layers")
                .and_then(Value::as_array_mut)
                .and_then(|layers| layers.get_mut(layer_index))
                .and_then(Value::as_object_mut)
                .expect("Dyson plan and target layer were validated");
            add_missing_frames(layer, &nodes, &mut next_id, &mut all_ids)? > 0
        }
        DysonPlanIntentKind::PlanShell => {
            let layer_id = intent
                .layer_id
                .as_deref()
                .expect("plan-shell intent has a validated layer ID");
            let (layer_index, nodes) = target_layer(original_plan, &nodes_by_layer, layer_id)?;
            if nodes.len() < 3 {
                bail!("native player-authority Dyson layer needs at least three nodes")
            }
            let layer = candidate_plan
                .get_mut("layers")
                .and_then(Value::as_array_mut)
                .and_then(|layers| layers.get_mut(layer_index))
                .and_then(Value::as_object_mut)
                .expect("Dyson plan and target layer were validated");
            let frames = add_missing_frames(layer, &nodes, &mut next_id, &mut all_ids)?;
            let shells = add_missing_shells(layer, &nodes, &mut next_id, &mut all_ids)?;
            frames + shells > 0
        }
        DysonPlanIntentKind::ClearShell => {
            let layer_id = intent
                .layer_id
                .as_deref()
                .expect("clear-shell intent has a validated layer ID");
            let (layer_index, _) = target_layer(original_plan, &nodes_by_layer, layer_id)?;
            let layer = candidate_plan
                .get_mut("layers")
                .and_then(Value::as_array_mut)
                .and_then(|layers| layers.get_mut(layer_index))
                .and_then(Value::as_object_mut)
                .expect("Dyson plan and target layer were validated");
            let shells = layer
                .get_mut("shells")
                .and_then(Value::as_array_mut)
                .ok_or_else(|| {
                    anyhow!("native player-authority Dyson shell directory is invalid")
                })?;
            if shells.is_empty() {
                false
            } else {
                shells.clear();
                true
            }
        }
    };
    if !changed {
        bail!("native player-authority Dyson plan target is unchanged")
    }
    reconcile_plan(&mut candidate_plan)?;

    let mut top_level_changes = vec![ValuePatch {
        path: vec![
            PathSegment::Key("dysonPlans".to_owned()),
            PathSegment::Key(intent.system_id),
        ],
        operation: "set".to_owned(),
        value: Some(Value::Object(candidate_plan)),
    }];
    if next_id != original_next_id {
        top_level_changes.push(ValuePatch {
            path: vec![PathSegment::Key("nextId".to_owned())],
            operation: "set".to_owned(),
            value: Some(Value::from(next_id)),
        });
    }
    Ok(SimulationCommandPatch {
        protocol_version: command.protocol_version,
        base_revision: command.base_revision,
        top_level_changes,
        changed_entities: Vec::new(),
        added_entities: Vec::new(),
        removed_entity_ids: Vec::new(),
        changed_belts: Vec::new(),
        added_belts: Vec::new(),
        removed_belt_ids: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        CoreCheckpointIdentity,
        catalog::{CatalogSnapshot, RuntimeCatalog},
        command::EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT,
    };

    fn catalog() -> RuntimeCatalog {
        let snapshot: CatalogSnapshot = serde_json::from_value(json!({
            "protocolVersion": crate::CORE_PROTOCOL_VERSION,
            "registryFingerprint": EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT,
            "planets": [
                { "id": "home", "systemId": "helios", "kind": "terrestrial", "orbitIndex": 1 },
                { "id": "away", "systemId": "sigma", "kind": "terrestrial", "orbitIndex": 1 }
            ],
            "items": [{ "id": "universe_matrix", "kind": "matrix" }],
            "buildings": [],
            "recipes": [],
            "constructions": [],
            "belts": [],
            "technologies": [
                {
                    "id": "dyson_sphere_program",
                    "costs": [{ "itemId": "universe_matrix", "amount": 1 }],
                    "prerequisites": []
                },
                {
                    "id": "dyson_shell",
                    "costs": [{ "itemId": "universe_matrix", "amount": 1 }],
                    "prerequisites": ["dyson_sphere_program"]
                }
            ]
        }))
        .unwrap();
        RuntimeCatalog::validate(snapshot, EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT).unwrap()
    }

    fn state() -> CoreState {
        let base = json!({
            "version": 47,
            "mode": "normal",
            "activePlanetId": "home",
            "elapsedSeconds": 10,
            "paused": false,
            "nextId": 100,
            "research": {
                "completedTechIds": ["dyson_sphere_program", "dyson_shell"]
            },
            "exploration": {
                "unlockedSystemIds": ["helios"]
            },
            "dysonPlans": {
                "helios": {
                    "activeLayerId": "mod:layer/alpha🚀",
                    "structurePoints": 12,
                    "shellSails": 80,
                    "layers": [{
                        "id": "mod:layer/alpha🚀",
                        "name": "Alpha",
                        "radius": 10000,
                        "inclination": 0,
                        "longitude": 0,
                        "structureAllocationFloor": 0,
                        "shellAllocationFloor": 0,
                        "nodes": [
                            { "id": "node-c", "angle": 180, "requiredStructurePoints": 1, "completedStructurePoints": 1 },
                            { "id": "node-a", "angle": 0, "requiredStructurePoints": 1, "completedStructurePoints": 1 },
                            { "id": "node-d", "angle": 270, "requiredStructurePoints": 1, "completedStructurePoints": 1 },
                            { "id": "node-b", "angle": 90, "requiredStructurePoints": 1, "completedStructurePoints": 1 }
                        ],
                        "frames": [],
                        "shells": []
                    }]
                }
            }
        })
        .as_object()
        .unwrap()
        .clone();
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
            base,
            Vec::new(),
            Vec::new(),
            catalog(),
        )
        .unwrap()
    }

    fn semantic_intent(revision: u64, value: Value) -> SimulationCommandPatch {
        SimulationCommandPatch {
            protocol_version: crate::CORE_PROTOCOL_VERSION,
            base_revision: revision,
            top_level_changes: vec![ValuePatch {
                path: vec![
                    PathSegment::Key(INTENT_ROOT.to_owned()),
                    PathSegment::Key(INTENT_LEAF.to_owned()),
                ],
                operation: "set".to_owned(),
                value: Some(value),
            }],
            changed_entities: Vec::new(),
            added_entities: Vec::new(),
            removed_entity_ids: Vec::new(),
            changed_belts: Vec::new(),
            added_belts: Vec::new(),
            removed_belt_ids: Vec::new(),
        }
    }

    fn intent(revision: u64, kind: &str) -> SimulationCommandPatch {
        semantic_intent(
            revision,
            json!({
                "kind": kind,
                "systemId": "helios",
                "layerId": "mod:layer/alpha🚀"
            }),
        )
    }

    fn layer(state: &CoreState) -> &Map<String, Value> {
        state.base_value()["dysonPlans"]["helios"]["layers"][0]
            .as_object()
            .unwrap()
    }

    #[test]
    fn auto_connect_is_a_compact_semantic_intent_with_stable_sorted_edges() {
        let mut state = state();
        let command = intent(state.revision, "auto-connect");
        state.validate_player_authority_command(&command).unwrap();
        let serialized = serde_json::to_vec(&command).unwrap();
        assert!(serialized.len() < 512);
        let result = state.apply_command(&command).unwrap();
        assert_eq!(result.revision, 8);
        assert!(result.topology_dirty);
        let frames = layer(&state)["frames"].as_array().unwrap();
        assert_eq!(frames.len(), 4);
        assert_eq!(
            frames
                .iter()
                .map(|frame| (
                    frame["id"].as_str().unwrap(),
                    frame["sourceNodeId"].as_str().unwrap(),
                    frame["targetNodeId"].as_str().unwrap(),
                    frame["requiredStructurePoints"].as_f64().unwrap() as u64,
                ))
                .collect::<Vec<_>>(),
            vec![
                ("dyson_frame_100", "node-a", "node-b", 2),
                ("dyson_frame_101", "node-b", "node-c", 2),
                ("dyson_frame_102", "node-c", "node-d", 2),
                ("dyson_frame_103", "node-d", "node-a", 2),
            ]
        );
        assert_eq!(state.base_value()["nextId"], Value::from(104));
        assert_eq!(
            state.base_value()["dysonPlans"]["helios"]["structurePoints"].as_f64(),
            Some(12.0)
        );
        assert_eq!(
            state.base_value()["dysonPlans"]["helios"]["shellSails"].as_f64(),
            Some(80.0)
        );
    }

    #[test]
    fn plan_shell_connects_frames_then_derives_shells_without_minting_material() {
        let mut state = state();
        let command = intent(state.revision, "plan-shell");
        state.validate_player_authority_command(&command).unwrap();
        state.apply_command(&command).unwrap();
        let layer = layer(&state);
        assert_eq!(layer["frames"].as_array().unwrap().len(), 4);
        let shells = layer["shells"].as_array().unwrap();
        assert_eq!(shells.len(), 4);
        assert_eq!(shells[0]["id"], "dyson_shell_104");
        assert_eq!(shells[0]["boundaryFrameIds"], json!(["dyson_frame_100"]));
        assert_eq!(shells[0]["sailCapacity"].as_f64(), Some(80.0));
        assert_eq!(state.base_value()["nextId"], 108);
        assert_eq!(
            state.base_value()["dysonPlans"]["helios"]["structurePoints"].as_f64(),
            Some(12.0)
        );
        assert_eq!(
            state.base_value()["dysonPlans"]["helios"]["shellSails"].as_f64(),
            Some(80.0)
        );
        assert_eq!(
            shells
                .iter()
                .map(|shell| shell["absorbedSails"].as_f64().unwrap() as u64)
                .sum::<u64>(),
            80
        );
    }

    #[test]
    fn clear_shell_preserves_material_and_replay_is_deterministic() {
        let initial = state();
        let plan = intent(initial.revision, "plan-shell");
        let mut live = initial.clone();
        live.apply_command(&plan).unwrap();
        let mut replayed = initial;
        replayed.apply_command(&plan).unwrap();
        assert_eq!(live.base_value(), replayed.base_value());

        let clear = intent(live.revision, "clear-shell");
        live.validate_player_authority_command(&clear).unwrap();
        live.apply_command(&clear).unwrap();
        assert!(layer(&live)["shells"].as_array().unwrap().is_empty());
        assert_eq!(
            live.base_value()["dysonPlans"]["helios"]["structurePoints"].as_f64(),
            Some(12.0)
        );
        assert_eq!(
            live.base_value()["dysonPlans"]["helios"]["shellSails"].as_f64(),
            Some(80.0)
        );
        assert_eq!(live.base_value()["nextId"], 108);
    }

    #[test]
    fn layer_lifecycle_and_geometry_are_rust_derived_without_changing_material_totals() {
        let mut live = state();
        let add_blank = semantic_intent(
            live.revision,
            json!({ "kind": "add-layer", "systemId": "helios" }),
        );
        live.validate_player_authority_command(&add_blank).unwrap();
        live.apply_command(&add_blank).unwrap();
        assert_eq!(live.base_value()["nextId"], 101);
        assert_eq!(
            live.base_value()["dysonPlans"]["helios"]["activeLayerId"],
            "dyson_layer_100"
        );
        assert_eq!(
            live.base_value()["dysonPlans"]["helios"]["layers"][1],
            json!({
                "id": "dyson_layer_100",
                "name": "壳层 2",
                "radius": 14000,
                "inclination": 0,
                "longitude": 0,
                "nodes": [],
                "frames": [],
                "shells": [],
                "structureAllocationFloor": 0.0,
                "shellAllocationFloor": 0.0,
            })
        );

        let add_standard = semantic_intent(
            live.revision,
            json!({ "kind": "add-standard-layer", "systemId": "helios" }),
        );
        live.apply_command(&add_standard).unwrap();
        let plan = live.base_value()["dysonPlans"]["helios"]
            .as_object()
            .unwrap();
        let standard = plan["layers"][2].as_object().unwrap();
        assert_eq!(standard["id"], "dyson_layer_101");
        assert_eq!(standard["name"], "标准壳层 3");
        assert_eq!(standard["radius"], 18_000);
        assert_eq!(standard["longitude"], 48);
        assert_eq!(standard["nodes"].as_array().unwrap().len(), 8);
        assert_eq!(standard["frames"].as_array().unwrap().len(), 8);
        assert_eq!(standard["shells"].as_array().unwrap().len(), 8);
        assert_eq!(standard["nodes"][0]["id"], "dyson_node_102");
        assert_eq!(standard["frames"][0]["id"], "dyson_frame_110");
        assert_eq!(standard["shells"][0]["id"], "dyson_shell_118");
        assert_eq!(live.base_value()["nextId"], 126);
        assert_eq!(plan["structurePoints"].as_f64(), Some(12.0));
        assert_eq!(plan["shellSails"].as_f64(), Some(80.0));

        let set_orbit = semantic_intent(
            live.revision,
            json!({
                "kind": "set-layer-orbit",
                "systemId": "helios",
                "layerId": "dyson_layer_101",
                "changes": { "radius": 20000, "inclination": -18, "longitude": 359.9 }
            }),
        );
        live.apply_command(&set_orbit).unwrap();
        let standard = live.base_value()["dysonPlans"]["helios"]["layers"][2]
            .as_object()
            .unwrap();
        assert_eq!(standard["radius"], 20_000);
        assert_eq!(standard["inclination"], -18);
        assert_eq!(standard["longitude"], 359.9);
        assert!(
            standard["frames"]
                .as_array()
                .unwrap()
                .iter()
                .all(|frame| frame["requiredStructurePoints"].as_f64() == Some(2.0))
        );
        assert!(
            standard["shells"]
                .as_array()
                .unwrap()
                .iter()
                .all(|shell| shell["sailCapacity"].as_f64() == Some(80.0))
        );

        let remove = semantic_intent(
            live.revision,
            json!({
                "kind": "remove-layer",
                "systemId": "helios",
                "layerId": "dyson_layer_100"
            }),
        );
        live.apply_command(&remove).unwrap();
        let plan = &live.base_value()["dysonPlans"]["helios"];
        assert_eq!(plan["layers"].as_array().unwrap().len(), 2);
        assert_eq!(plan["activeLayerId"], "dyson_layer_101");
        assert_eq!(plan["structurePoints"].as_f64(), Some(12.0));
        assert_eq!(plan["shellSails"].as_f64(), Some(80.0));
        assert_eq!(live.base_value()["nextId"], 126);
    }

    #[test]
    fn node_add_connect_and_cascade_remove_are_deterministic_and_material_neutral() {
        let mut live = state();
        let add = semantic_intent(
            live.revision,
            json!({
                "kind": "add-node",
                "systemId": "helios",
                "layerId": "mod:layer/alpha🚀",
                "angle": 45
            }),
        );
        live.apply_command(&add).unwrap();
        assert_eq!(layer(&live)["nodes"].as_array().unwrap().len(), 5);
        assert_eq!(layer(&live)["nodes"][4]["id"], "dyson_node_100");
        assert_eq!(live.base_value()["nextId"], 101);

        for (source, target) in [("node-a", "dyson_node_100"), ("dyson_node_100", "node-b")] {
            let connect = semantic_intent(
                live.revision,
                json!({
                    "kind": "connect-nodes",
                    "systemId": "helios",
                    "layerId": "mod:layer/alpha🚀",
                    "sourceNodeId": source,
                    "targetNodeId": target
                }),
            );
            live.apply_command(&connect).unwrap();
        }
        assert_eq!(layer(&live)["frames"].as_array().unwrap().len(), 2);
        assert_eq!(layer(&live)["frames"][0]["id"], "dyson_frame_101");
        assert_eq!(layer(&live)["frames"][1]["id"], "dyson_frame_102");
        assert_eq!(live.base_value()["nextId"], 103);

        let duplicate = semantic_intent(
            live.revision,
            json!({
                "kind": "connect-nodes",
                "systemId": "helios",
                "layerId": "mod:layer/alpha🚀",
                "sourceNodeId": "node-b",
                "targetNodeId": "dyson_node_100"
            }),
        );
        let before_duplicate = live.base_value().clone();
        assert!(live.apply_command(&duplicate).is_err());
        assert_eq!(live.base_value(), &before_duplicate);

        let shell = intent(live.revision, "plan-shell");
        live.apply_command(&shell).unwrap();
        assert_eq!(layer(&live)["frames"].as_array().unwrap().len(), 5);
        assert_eq!(layer(&live)["shells"].as_array().unwrap().len(), 5);
        assert_eq!(live.base_value()["nextId"], 111);

        let remove = semantic_intent(
            live.revision,
            json!({
                "kind": "remove-node",
                "systemId": "helios",
                "layerId": "mod:layer/alpha🚀",
                "nodeId": "dyson_node_100"
            }),
        );
        live.apply_command(&remove).unwrap();
        assert_eq!(layer(&live)["nodes"].as_array().unwrap().len(), 4);
        assert_eq!(layer(&live)["frames"].as_array().unwrap().len(), 3);
        assert_eq!(layer(&live)["shells"].as_array().unwrap().len(), 3);
        assert!(
            !serde_json::to_string(layer(&live))
                .unwrap()
                .contains("dyson_node_100")
        );
        assert_eq!(
            live.base_value()["dysonPlans"]["helios"]["structurePoints"].as_f64(),
            Some(12.0)
        );
        assert_eq!(
            live.base_value()["dysonPlans"]["helios"]["shellSails"].as_f64(),
            Some(80.0)
        );
        assert_eq!(live.base_value()["nextId"], 111);

        let too_close = semantic_intent(
            live.revision,
            json!({
                "kind": "add-node",
                "systemId": "helios",
                "layerId": "mod:layer/alpha🚀",
                "angle": 3
            }),
        );
        let before_close = live.base_value().clone();
        assert!(live.apply_command(&too_close).is_err());
        assert_eq!(live.base_value(), &before_close);
    }

    #[test]
    fn locked_noop_collision_and_renderer_authored_arrays_fail_closed() {
        let mut locked = state();
        locked.base_value_mut()["research"]["completedTechIds"] = json!([]);
        assert!(
            locked
                .validate_player_authority_command(&intent(locked.revision, "auto-connect"))
                .is_err()
        );

        let mut collision = state();
        collision.base_value_mut()["dysonPlans"]["helios"]["layers"][0]["frames"] = json!([{
            "id": "dyson_frame_100",
            "sourceNodeId": "node-a",
            "targetNodeId": "node-c",
            "requiredStructurePoints": 4,
            "completedStructurePoints": 4
        }]);
        assert!(
            collision
                .validate_player_authority_command(&intent(collision.revision, "auto-connect"))
                .is_err()
        );

        let mut connected = state();
        let first = intent(connected.revision, "auto-connect");
        connected.apply_command(&first).unwrap();
        assert!(
            connected
                .validate_player_authority_command(&intent(connected.revision, "auto-connect"))
                .is_err()
        );

        let mut cross_system_collision = state();
        cross_system_collision.base_value_mut()["dysonPlans"]["sigma"] = json!({
            "activeLayerId": "dyson_layer_100",
            "structurePoints": 0,
            "shellSails": 0,
            "layers": [{
                "id": "dyson_layer_100",
                "name": "collision",
                "radius": 10000,
                "inclination": 0,
                "longitude": 0,
                "structureAllocationFloor": 0,
                "shellAllocationFloor": 0,
                "nodes": [],
                "frames": [],
                "shells": []
            }]
        });
        assert!(
            cross_system_collision
                .validate_player_authority_command(&semantic_intent(
                    cross_system_collision.revision,
                    json!({ "kind": "add-layer", "systemId": "helios" })
                ))
                .is_err()
        );

        let mut forged = intent(7, "plan-shell");
        forged.top_level_changes.push(ValuePatch {
            path: vec![PathSegment::Key("dysonPlans".to_owned())],
            operation: "set".to_owned(),
            value: Some(json!({ "forged": true })),
        });
        assert!(state().validate_player_authority_command(&forged).is_err());
    }
}
