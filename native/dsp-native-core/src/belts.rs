use std::collections::HashMap;
use std::mem::size_of;

use anyhow::{Context, anyhow, bail};
use num_bigint::BigUint;
use serde_json::{Map, Number, Value};

use crate::state::CoreState;

const EPSILON: f64 = 0.0001;

pub(crate) type OutputCredits = HashMap<(usize, u32), f64>;

#[derive(Debug, Default)]
pub(crate) struct BeltStepReservation {
    // Indexed by the immutable belt row. NaN means that the JS reservation
    // pass did not cap this belt; using IDs here allocated and hashed more than
    // 150,000 strings every simulated second on the player stress save.
    pub allowance_by_belt: Vec<f64>,
    pub output_credits: OutputCredits,
}

#[derive(Debug)]
pub(crate) struct BeltRuntime {
    progress: Vec<f64>,
    total_transferred: Vec<f64>,
    congestion: Vec<f64>,
    last_flow: Vec<f64>,
    total_dirty: Vec<bool>,
}

impl BeltRuntime {
    pub(crate) fn from_values(belts: &[Value]) -> anyhow::Result<Self> {
        let mut runtime = Self {
            progress: Vec::with_capacity(belts.len()),
            total_transferred: Vec::with_capacity(belts.len()),
            congestion: Vec::with_capacity(belts.len()),
            last_flow: Vec::with_capacity(belts.len()),
            total_dirty: vec![false; belts.len()],
        };
        for belt in belts {
            let belt = belt
                .as_object()
                .ok_or_else(|| anyhow!("native belt record is not an object"))?;
            runtime.progress.push(finite_number(belt.get("progress")));
            runtime
                .total_transferred
                .push(finite_number(belt.get("totalTransferred")));
            runtime
                .congestion
                .push(finite_number(belt.get("congestion")));
            runtime.last_flow.push(finite_number(belt.get("lastFlow")));
        }
        Ok(runtime)
    }

    pub(crate) fn write_back(self, belts: &mut [Value]) -> anyhow::Result<()> {
        if belts.len() != self.progress.len() {
            bail!("native belt runtime topology changed");
        }
        for (index, belt) in belts.iter_mut().enumerate() {
            let belt = belt
                .as_object_mut()
                .ok_or_else(|| anyhow!("native belt record is not an object"))?;
            set_number(belt, "progress", self.progress[index])?;
            set_number(belt, "lastFlow", self.last_flow[index])?;
            set_number(belt, "congestion", self.congestion[index])?;
            if self.total_dirty[index] {
                set_number(belt, "totalTransferred", self.total_transferred[index])?;
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone)]
struct Route {
    belt_index: usize,
    source_index: usize,
    target_index: usize,
    source_group: usize,
    target_slot: usize,
    belt_sort_rank: usize,
    target_port_index: Option<u8>,
    capacity: f64,
    priority: usize,
}

#[derive(Debug, Clone)]
pub(crate) struct PreparedRoutes {
    routes: Vec<Route>,
    groups: Vec<PreparedGroup>,
    target_slot_count: usize,
}

#[derive(Debug, Clone)]
struct PreparedGroup {
    source_index: usize,
    item_symbol: u32,
    balanced_splitter: bool,
    route_indices: Vec<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum TargetSlotKey {
    Entity {
        target_index: usize,
        item: u32,
    },
    BlackHole {
        target_index: usize,
        port: i16,
    },
    OrbitalCargo {
        target_index: usize,
        item: u32,
        port: i16,
    },
    Tray {
        planet: u32,
        item: u32,
    },
}

impl PreparedRoutes {
    pub(crate) fn estimated_bytes(&self) -> u64 {
        (self.routes.capacity() * size_of::<Route>()
            + self.groups.capacity() * size_of::<PreparedGroup>()
            + self
                .groups
                .iter()
                .map(|group| group.route_indices.capacity() * size_of::<usize>())
                .sum::<usize>()) as u64
    }
}

#[derive(Debug)]
struct Candidate {
    route_index: usize,
    allowance: f64,
    moved: f64,
}

#[derive(Debug)]
struct Group {
    available: f64,
    source_had_output: bool,
    first_candidate: Option<Candidate>,
    candidates: Vec<Candidate>,
    first_inactive_route: Option<usize>,
    inactive_routes: Vec<usize>,
}

#[derive(Debug, Clone, Copy, Default)]
enum BeltPostAction {
    #[default]
    None,
    ResetProgress,
    Flow {
        available: f64,
        free: f64,
        moved: f64,
    },
}

fn advance_belt_clocks(
    runtime: &mut BeltRuntime,
    routes: &[Route],
    seconds: f64,
    belt_limit: f64,
) -> anyhow::Result<()> {
    if seconds <= 0.0 || runtime.progress.is_empty() {
        return Ok(());
    }
    let flow_decay = 0.8_f64.powf(seconds);
    let congestion_decay = 0.85_f64.powf(seconds);
    for (index, route) in routes.iter().enumerate() {
        runtime.last_flow[index] = rounded(runtime.last_flow[index] * flow_decay, 3);
        runtime.congestion[index] = rounded(runtime.congestion[index] * congestion_decay, 3);
        let current = runtime.progress[index].max(0.0);
        let progress = if current > belt_limit {
            current
        } else {
            (current + route.capacity * seconds).min(belt_limit)
        };
        runtime.progress[index] = rounded(progress, 4);
    }
    Ok(())
}

fn apply_belt_post_actions(
    runtime: &mut BeltRuntime,
    routes: &[Route],
    actions: &[BeltPostAction],
    seconds: f64,
    defer_source_depletion_reset: bool,
    flow_window_seconds: f64,
) -> anyhow::Result<()> {
    for (index, (route, action)) in routes.iter().zip(actions).enumerate() {
        match *action {
            BeltPostAction::None => {}
            BeltPostAction::ResetProgress => runtime.progress[index] = 0.0,
            BeltPostAction::Flow {
                available,
                free,
                moved,
            } => {
                runtime.progress[index] =
                    if !defer_source_depletion_reset && available <= 0.0 || free <= 0.0 {
                        0.0
                    } else {
                        rounded((runtime.progress[index] - moved).max(0.0), 4)
                    };
                if moved > 0.0 {
                    if flow_window_seconds > 0.0 {
                        let prior = if seconds > 0.0 {
                            0.0
                        } else {
                            runtime.last_flow[index]
                        };
                        runtime.last_flow[index] =
                            rounded(route.capacity.min(prior + moved / flow_window_seconds), 3);
                    }
                    runtime.total_transferred[index] =
                        (runtime.total_transferred[index] + moved).floor();
                    runtime.total_dirty[index] = true;
                }
                let load = if route.capacity > EPSILON {
                    runtime.last_flow[index] / route.capacity
                } else {
                    0.0
                };
                runtime.congestion[index] = rounded(
                    1.0_f64.min(load.max(if available > 0.0 && free <= 0.0 {
                        1.0
                    } else {
                        0.0
                    })),
                    3,
                );
            }
        }
    }
    Ok(())
}

fn finite_number(value: Option<&Value>) -> f64 {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .unwrap_or(0.0)
}

fn string_at<'a>(object: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    object.get(key).and_then(Value::as_str)
}

fn rounded(value: f64, digits: i32) -> f64 {
    let scale = 10_f64.powi(digits);
    (value * scale).round() / scale
}

fn set_number(object: &mut Map<String, Value>, key: &str, value: f64) -> anyhow::Result<()> {
    let value = Value::Number(
        Number::from_f64(value)
            .ok_or_else(|| anyhow!("native belt simulation produced a non-finite number"))?,
    );
    if let Some(target) = object.get_mut(key) {
        *target = value;
    } else {
        object.insert(key.to_owned(), value);
    }
    Ok(())
}

fn normalized_buffer_limit(value: Option<&Value>) -> f64 {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .unwrap_or(1_000_000.0)
        .floor()
        .clamp(1_000.0, 100_000_000.0)
}

fn stacked_capacity(base: f64, count: f64, limit: f64) -> f64 {
    let base = base.max(0.0).floor();
    let count = count.floor().max(1.0);
    if base == 0.0 {
        0.0
    } else if base > limit / count {
        limit
    } else {
        (base * count).min(limit)
    }
}

fn output_amount(entity: &Map<String, Value>, item_id: &str) -> f64 {
    entity
        .get("outputs")
        .and_then(Value::as_object)
        .and_then(|outputs| outputs.get(item_id))
        .map(|value| finite_number(Some(value)))
        .unwrap_or(0.0)
}

fn input_amount(entity: &Map<String, Value>, item_id: &str) -> f64 {
    entity
        .get("inputs")
        .and_then(Value::as_object)
        .and_then(|inputs| inputs.get(item_id))
        .map(|value| finite_number(Some(value)))
        .unwrap_or(0.0)
}

fn set_output(entity: &mut Map<String, Value>, item_id: &str, amount: f64) -> anyhow::Result<()> {
    let outputs = entity
        .get_mut("outputs")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native belt source outputs are missing"))?;
    outputs.insert(
        item_id.to_owned(),
        Number::from_f64(amount)
            .map(Value::Number)
            .ok_or_else(|| anyhow!("native belt output is non-finite"))?,
    );
    Ok(())
}

fn add_input(entity: &mut Map<String, Value>, item_id: &str, amount: f64) -> anyhow::Result<()> {
    let inputs = entity
        .get_mut("inputs")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native belt target inputs are missing"))?;
    let current = inputs
        .get(item_id)
        .map(|value| finite_number(Some(value)))
        .unwrap_or(0.0);
    inputs.insert(
        item_id.to_owned(),
        Number::from_f64((current + amount).floor())
            .map(Value::Number)
            .ok_or_else(|| anyhow!("native belt input is non-finite"))?,
    );
    Ok(())
}

fn black_hole_active(target: &Map<String, Value>) -> bool {
    string_at(target, "buildingId") == Some("micro_black_hole_connector")
        && target.get("blackHolePaused").and_then(Value::as_bool) == Some(false)
        && target
            .get("blackHoleActivationConfirmed")
            .and_then(Value::as_bool)
            == Some(true)
}

fn material_delivery_slot_accepts(
    target: &Map<String, Value>,
    item_id: &str,
    port_index: Option<u8>,
) -> bool {
    let Some(index) = port_index.filter(|index| *index <= 2).map(usize::from) else {
        return false;
    };
    if let Some(slots) = target.get("deliverySlots").and_then(Value::as_array) {
        let Some(slot) = slots.get(index).and_then(Value::as_object) else {
            return false;
        };
        if string_at(slot, "mode") == Some("disabled") {
            return false;
        }
        return string_at(slot, "itemId").is_none_or(|configured| configured == item_id);
    }
    target
        .get("deliveryItemIds")
        .and_then(Value::as_array)
        .and_then(|items| items.get(index))
        .and_then(Value::as_str)
        .is_some_and(|configured| configured == item_id)
}

fn black_hole_port_mut(
    target: &mut Map<String, Value>,
    port_index: Option<u8>,
) -> Option<&mut Map<String, Value>> {
    let index = u64::from(port_index?);
    target
        .get_mut("blackHolePorts")
        .and_then(Value::as_array_mut)?
        .iter_mut()
        .filter_map(Value::as_object_mut)
        .find(|port| port.get("index").and_then(Value::as_u64) == Some(index))
}

fn add_black_hole_destroyed(
    target: &mut Map<String, Value>,
    port_index: Option<u8>,
    item_id: &str,
    amount: f64,
) -> anyhow::Result<bool> {
    if !black_hole_active(target) {
        return Ok(false);
    }
    let Some(port) = black_hole_port_mut(target, port_index) else {
        return Ok(false);
    };
    let current = port
        .get("totalDestroyed")
        .and_then(Value::as_str)
        .and_then(|value| BigUint::parse_bytes(value.as_bytes(), 10))
        .unwrap_or_default();
    let moved = amount.floor().max(0.0) as u64;
    port.insert("currentItemId".to_owned(), Value::from(item_id));
    port.insert(
        "totalDestroyed".to_owned(),
        Value::from((current + BigUint::from(moved)).to_string()),
    );
    Ok(true)
}

fn move_to_target(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entities: &mut [Value],
    quantum_bandwidth: crate::quantum_logistics::RuntimeBandwidth,
    quantum_session: &mut Option<crate::quantum_logistics::SupplyDepositSession>,
    route: &Route,
    item_id: &str,
    requested: f64,
) -> anyhow::Result<f64> {
    let target = entities[route.target_index]
        .as_object_mut()
        .ok_or_else(|| anyhow!("native belt target is not an object"))?;
    if string_at(target, "buildingId") == Some("micro_black_hole_connector") {
        return Ok(
            if add_black_hole_destroyed(target, route.target_port_index, item_id, requested)? {
                requested
            } else {
                0.0
            },
        );
    }
    if crate::quantum_logistics::is_supply_endpoint(target, item_id) {
        return crate::quantum_logistics::receive_supply_material_in_session(
            state,
            base,
            quantum_bandwidth,
            quantum_session,
            target,
            item_id,
            requested,
        );
    }
    add_input(target, item_id, requested)?;
    Ok(requested)
}

fn source_produces(state: &CoreState, source: &Map<String, Value>, item_id: &str) -> bool {
    match string_at(source, "kind") {
        Some("vein") => string_at(source, "resourceId") == Some(item_id),
        Some("machine" | "power") => string_at(source, "recipeId")
            .and_then(|id| state.catalog.recipes.get(id))
            .is_some_and(|recipe| {
                recipe
                    .outputs
                    .iter()
                    .any(|output| output.item_id == item_id)
            }),
        Some("storage" | "splitter") => string_at(source, "storedItemId") == Some(item_id),
        Some("station") => source
            .get("stationSlots")
            .and_then(Value::as_array)
            .is_some_and(|slots| {
                slots
                    .iter()
                    .filter_map(Value::as_object)
                    .any(|slot| string_at(slot, "itemId") == Some(item_id))
            }),
        _ => false,
    }
}

fn target_consumes(
    state: &CoreState,
    target: &Map<String, Value>,
    item_id: &str,
    target_port_index: Option<u8>,
) -> bool {
    if string_at(target, "buildingId") == Some("orbital_cargo_terminal") {
        return crate::orbital_station::terminal_accepts(state, target, item_id, target_port_index);
    }
    if matches!(
        string_at(target, "buildingId"),
        Some("micro_black_hole_connector" | "material_delivery_hub")
    ) {
        return state.catalog.items.contains_key(item_id);
    }
    match string_at(target, "kind") {
        Some("machine" | "power") => {
            let accepts_proliferator = target
                .get("sprayCoaterInstalled")
                .and_then(Value::as_bool)
                .unwrap_or(false)
                && target
                    .get("proliferatorTier")
                    .and_then(Value::as_u64)
                    .and_then(|tier| u8::try_from(tier).ok())
                    .and_then(|tier| state.catalog.proliferators.get(&tier))
                    .is_some_and(|definition| definition.item_id == item_id);
            let accepts_research_matrix = string_at(target, "recipeId") == Some("matrix_research")
                && matches!(
                    item_id,
                    "electromagnetic_matrix"
                        | "energy_matrix"
                        | "structure_matrix"
                        | "information_matrix"
                        | "gravity_matrix"
                        | "universe_matrix"
                );
            let accepts_fuel = string_at(target, "buildingId")
                .and_then(|id| state.catalog.buildings.get(id))
                .is_some_and(|building| {
                    building.fuel_item_ids.iter().any(|id| id == item_id)
                        && string_at(target, "fuelItemId")
                            .is_none_or(|selected| selected == item_id)
                });
            accepts_fuel
                || accepts_proliferator
                || accepts_research_matrix
                || string_at(target, "recipeId")
                    .and_then(|id| state.catalog.recipes.get(id))
                    .is_some_and(|recipe| {
                        recipe.inputs.iter().any(|input| input.item_id == item_id)
                    })
        }
        Some("storage" | "splitter") => {
            if string_at(target, "storedItemId") != Some(item_id) {
                return false;
            }
            let Some(building) =
                string_at(target, "buildingId").and_then(|id| state.catalog.buildings.get(id))
            else {
                return false;
            };
            let item_kind = state
                .catalog
                .items
                .get(item_id)
                .map(|item| item.kind.as_str())
                .unwrap_or_default();
            match building.accepts.as_deref().unwrap_or("any") {
                "any" => true,
                "solid" => matches!(item_kind, "solid" | "matrix"),
                accepted => accepted == item_kind,
            }
        }
        Some("station") => target
            .get("stationSlots")
            .and_then(Value::as_array)
            .is_some_and(|slots| {
                slots
                    .iter()
                    .filter_map(Value::as_object)
                    .any(|slot| string_at(slot, "itemId") == Some(item_id))
            }),
        _ => false,
    }
}

fn target_capacity(
    state: &CoreState,
    base: &Map<String, Value>,
    quantum_session: &mut Option<crate::quantum_logistics::SupplyDepositSession>,
    entities: &[Value],
    target: &Map<String, Value>,
    item_id: &str,
    target_port_index: Option<u8>,
) -> anyhow::Result<f64> {
    if string_at(target, "buildingId") == Some("micro_black_hole_connector") {
        let port_exists = target
            .get("blackHolePorts")
            .and_then(Value::as_array)
            .is_some_and(|ports| {
                ports.iter().filter_map(Value::as_object).any(|port| {
                    port.get("index").and_then(Value::as_u64) == target_port_index.map(u64::from)
                })
            });
        return Ok(if black_hole_active(target) && port_exists {
            9_007_199_254_740_991.0
        } else {
            0.0
        });
    }
    if string_at(target, "buildingId") == Some("material_delivery_hub") {
        if !material_delivery_slot_accepts(target, item_id, target_port_index) {
            return Ok(0.0);
        }
        if matches!(item_id, "logistics_drone" | "logistics_vessel") {
            return Ok(9_007_199_254_740_991.0);
        }
        let planet_id = string_at(target, "planetId").unwrap_or_default();
        let active_planet_id = base
            .get("activePlanetId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let tray = if planet_id == active_planet_id {
            base.get("tray").and_then(Value::as_object)
        } else {
            base.get("planetTrays")
                .and_then(Value::as_object)
                .and_then(|trays| trays.get(planet_id))
                .and_then(Value::as_object)
        };
        let current = tray
            .and_then(|tray| tray.get(item_id))
            .map(|value| finite_number(Some(value)).floor())
            .unwrap_or(0.0);
        let limit = base
            .get("planetTrayItemLimits")
            .and_then(Value::as_object)
            .and_then(|limits| limits.get(planet_id))
            .map(|value| {
                finite_number(Some(value))
                    .floor()
                    .clamp(1_000.0, 100_000_000.0)
            })
            .unwrap_or(1_000_000.0);
        let pending = state
            .factory_topology
            .material_delivery_hub_indices
            .iter()
            .filter_map(|&index| entities[index].as_object())
            .filter(|entity| string_at(entity, "planetId") == Some(planet_id))
            .map(|entity| input_amount(entity, item_id).floor().max(0.0))
            .sum::<f64>();
        return Ok((limit - current - pending).max(0.0));
    }
    if let Some(capacity) = crate::quantum_logistics::supply_free_capacity_in_session(
        state,
        base,
        quantum_session,
        target,
        item_id,
    )? {
        return Ok(capacity);
    }
    let building = string_at(target, "buildingId")
        .and_then(|id| state.catalog.buildings.get(id))
        .ok_or_else(|| anyhow!("native belt target building is missing"))?;
    let logistics = matches!(
        string_at(target, "kind"),
        Some("storage" | "splitter" | "station")
    );
    let limit = normalized_buffer_limit(base.get("settings").and_then(Value::as_object).and_then(
        |settings| {
            settings.get(if logistics {
                "logisticsBufferLimit"
            } else {
                "productionBufferLimit"
            })
        },
    ));
    let mut capacity = stacked_capacity(
        if string_at(target, "kind") == Some("station") {
            building.output_capacity
        } else {
            building.input_capacity
        },
        finite_number(target.get("machineCount")),
        limit,
    );
    if target
        .get("sprayCoaterInstalled")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        && target
            .get("proliferatorTier")
            .and_then(Value::as_u64)
            .and_then(|tier| u8::try_from(tier).ok())
            .and_then(|tier| state.catalog.proliferators.get(&tier))
            .is_some_and(|definition| definition.item_id == item_id)
    {
        let proliferator_limit = base
            .get("settings")
            .and_then(Value::as_object)
            .and_then(|settings| settings.get("proliferatorBufferLimit"))
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite())
            .unwrap_or(600.0)
            .floor()
            .clamp(1.0, 100_000_000.0);
        capacity = capacity.min(proliferator_limit);
    }
    if string_at(target, "kind") == Some("station") {
        if let Some(max_stock) = target
            .get("stationSlots")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_object)
            .find(|slot| string_at(slot, "itemId") == Some(item_id))
            .map(|slot| finite_number(slot.get("maxStock")).floor().max(0.0))
            .filter(|value| *value > 0.0)
        {
            capacity = capacity.min(max_stock);
        }
    }
    Ok(capacity - input_amount(target, item_id))
}

fn routes(state: &CoreState, entities: &[Value], belts: &[Value]) -> anyhow::Result<Vec<Route>> {
    belts
        .iter()
        .enumerate()
        .map(|(belt_index, belt)| {
            let belt = belt
                .as_object()
                .ok_or_else(|| anyhow!("native belt record is not an object"))?;
            let source_id = string_at(belt, "source")
                .ok_or_else(|| anyhow!("native belt source is missing"))?;
            let target_id = string_at(belt, "target")
                .ok_or_else(|| anyhow!("native belt target is missing"))?;
            let source_index = *state
                .entity_index
                .get(source_id)
                .ok_or_else(|| anyhow!("native belt source does not exist"))?;
            let target_index = *state
                .entity_index
                .get(target_id)
                .ok_or_else(|| anyhow!("native belt target does not exist"))?;
            if source_index >= entities.len() || target_index >= entities.len() {
                bail!("native belt route index is outside the entity table");
            }
            let tier = belt
                .get("tier")
                .and_then(Value::as_u64)
                .and_then(|value| u8::try_from(value).ok())
                .ok_or_else(|| anyhow!("native belt tier is invalid"))?;
            let speed = state
                .catalog
                .belt_speeds
                .get(&tier)
                .copied()
                .ok_or_else(|| anyhow!("native belt tier is not in the catalog"))?;
            let lanes = belt
                .get("lanes")
                .map(|value| finite_number(Some(value)))
                .unwrap_or(1.0)
                .floor();
            let stack_size = finite_number(belt.get("stackSize")).max(1.0).floor();
            let target_port_index = belt
                .get("targetPortIndex")
                .and_then(Value::as_u64)
                .and_then(|value| u8::try_from(value).ok());
            let _ = string_at(belt, "id").ok_or_else(|| anyhow!("native belt ID is missing"))?;
            Ok(Route {
                belt_index,
                source_index,
                target_index,
                source_group: 0,
                target_slot: 0,
                belt_sort_rank: 0,
                target_port_index,
                capacity: speed * lanes * stack_size,
                priority: belt
                    .get("priority")
                    .and_then(Value::as_u64)
                    .unwrap_or(1)
                    .min(2) as usize,
            })
        })
        .collect()
}

pub(crate) fn prepare_routes(
    state: &CoreState,
    entities: &[Value],
    belts: &[Value],
) -> anyhow::Result<PreparedRoutes> {
    let mut routes = routes(state, entities, belts)?;
    let mut group_by_key = HashMap::<(usize, u32), usize>::new();
    let mut target_slot_by_key = HashMap::<TargetSlotKey, usize>::new();
    let mut groups = Vec::<PreparedGroup>::new();
    for (route_index, route) in routes.iter_mut().enumerate() {
        let item_symbol = state.belts.items[route.belt_index];
        let source_group = *group_by_key
            .entry((route.source_index, item_symbol))
            .or_insert_with(|| {
                let source = entities[route.source_index]
                    .as_object()
                    .expect("validated belt source");
                let index = groups.len();
                groups.push(PreparedGroup {
                    source_index: route.source_index,
                    item_symbol,
                    balanced_splitter: string_at(source, "kind") == Some("splitter")
                        && string_at(source, "distributionMode") != Some("priority"),
                    route_indices: Vec::new(),
                });
                index
            });
        route.source_group = source_group;
        groups[source_group].route_indices.push(route_index);
        let target = entities[route.target_index]
            .as_object()
            .expect("validated belt target");
        let target_key = if string_at(target, "buildingId") == Some("micro_black_hole_connector") {
            TargetSlotKey::BlackHole {
                target_index: route.target_index,
                port: route.target_port_index.map_or(-1_i16, i16::from),
            }
        } else if string_at(target, "buildingId") == Some("material_delivery_hub") {
            TargetSlotKey::Tray {
                planet: state.entities.planets[route.target_index],
                item: item_symbol,
            }
        } else if string_at(target, "buildingId") == Some("orbital_cargo_terminal") {
            TargetSlotKey::OrbitalCargo {
                target_index: route.target_index,
                item: item_symbol,
                port: route.target_port_index.map_or(-1_i16, i16::from),
            }
        } else {
            TargetSlotKey::Entity {
                target_index: route.target_index,
                item: item_symbol,
            }
        };
        let next_target_slot = target_slot_by_key.len();
        route.target_slot = *target_slot_by_key
            .entry(target_key)
            .or_insert(next_target_slot);
    }
    for group in &mut groups {
        group.route_indices.sort_by(|left, right| {
            state.belts.ids[routes[*left].belt_index]
                .cmp(&state.belts.ids[routes[*right].belt_index])
        });
        for (rank, route_index) in group.route_indices.iter().copied().enumerate() {
            routes[route_index].belt_sort_rank = rank;
        }
    }
    Ok(PreparedRoutes {
        routes,
        groups,
        target_slot_count: target_slot_by_key.len(),
    })
}

pub(crate) fn admission_reason(state: &CoreState) -> anyhow::Result<Option<&'static str>> {
    if state.belt_index.is_empty() {
        return Ok(None);
    }
    let entities = (0..state.entity_index.len())
        .map(|index| state.parse_entity(index))
        .collect::<anyhow::Result<Vec<_>>>()?;
    let belts = (0..state.belt_index.len())
        .map(|index| state.parse_belt(index))
        .collect::<anyhow::Result<Vec<_>>>()?;
    let entity_index = entities
        .iter()
        .enumerate()
        .filter_map(|(index, entity)| {
            entity
                .as_object()
                .and_then(|object| string_at(object, "id"))
                .map(|id| (id.to_owned(), index))
        })
        .collect::<HashMap<_, _>>();
    for belt in &belts {
        let Some(belt) = belt.as_object() else {
            return Ok(Some("ordinary-belt-record-invalid"));
        };
        if belt
            .get("elevatorOutputIndex")
            .is_some_and(|value| !value.is_null())
        {
            return Ok(Some("ordinary-belt-special-port-unsupported"));
        }
        let Some(source_id) = string_at(belt, "source") else {
            return Ok(Some("ordinary-belt-endpoint-invalid"));
        };
        let Some(target_id) = string_at(belt, "target") else {
            return Ok(Some("ordinary-belt-endpoint-invalid"));
        };
        let Some(item_id) = string_at(belt, "itemId") else {
            return Ok(Some("ordinary-belt-item-invalid"));
        };
        let (Some(&source_index), Some(&target_index)) =
            (entity_index.get(source_id), entity_index.get(target_id))
        else {
            return Ok(Some("ordinary-belt-endpoint-invalid"));
        };
        if source_index == target_index {
            return Ok(Some("ordinary-belt-endpoint-invalid"));
        }
        let source = entities[source_index]
            .as_object()
            .expect("validated entity");
        let target = entities[target_index]
            .as_object()
            .expect("validated entity");
        let target_port_index = belt
            .get("targetPortIndex")
            .and_then(Value::as_u64)
            .and_then(|value| u8::try_from(value).ok());
        if string_at(target, "buildingId") == Some("micro_black_hole_connector") {
            let valid_port = target_port_index.is_some_and(|index| index <= 2)
                && target
                    .get("blackHolePorts")
                    .and_then(Value::as_array)
                    .is_some_and(|ports| {
                        ports.iter().filter_map(Value::as_object).any(|port| {
                            port.get("index").and_then(Value::as_u64)
                                == target_port_index.map(u64::from)
                        })
                    });
            if !valid_port {
                return Ok(Some("black-hole-belt-port-invalid"));
            }
        } else if string_at(target, "buildingId") == Some("material_delivery_hub") {
            if !material_delivery_slot_accepts(target, item_id, target_port_index) {
                return Ok(Some("material-delivery-belt-port-invalid"));
            }
        } else if string_at(target, "buildingId") == Some("orbital_cargo_terminal") {
            if !crate::orbital_station::terminal_accepts(state, target, item_id, target_port_index)
            {
                return Ok(Some("orbital-cargo-belt-port-invalid"));
            }
        } else if belt
            .get("targetPortIndex")
            .is_some_and(|value| !value.is_null())
        {
            return Ok(Some("ordinary-belt-special-port-unsupported"));
        }
        let planet = string_at(belt, "planetId");
        if planet != string_at(source, "planetId") || planet != string_at(target, "planetId") {
            return Ok(Some("ordinary-belt-planet-invalid"));
        }
        if !source_produces(state, source, item_id)
            || !target_consumes(state, target, item_id, target_port_index)
        {
            return Ok(Some("ordinary-belt-route-unsupported"));
        }
        let tier = belt
            .get("tier")
            .and_then(Value::as_u64)
            .and_then(|value| u8::try_from(value).ok());
        let lanes = belt
            .get("lanes")
            .map(|value| finite_number(Some(value)))
            .unwrap_or(1.0);
        let stack_size = belt
            .get("stackSize")
            .map_or(1.0, |value| finite_number(Some(value)));
        let priority = belt.get("priority").and_then(Value::as_u64).unwrap_or(1);
        if tier.is_none_or(|tier| !state.catalog.belt_speeds.contains_key(&tier))
            || lanes < 1.0
            || lanes.fract().abs() > EPSILON
            || stack_size < 1.0
            || stack_size.fract().abs() > EPSILON
            || priority > 2
            || !state.catalog.items.contains_key(item_id)
        {
            return Ok(Some("ordinary-belt-definition-invalid"));
        }
    }
    Ok(None)
}

pub(crate) fn transfer(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entities: &mut [Value],
    belt_runtime: &mut BeltRuntime,
    prepared_routes: &PreparedRoutes,
    seconds: f64,
    defer_source_depletion_reset: bool,
    allowance_caps: Option<&[f64]>,
    flow_window_seconds: f64,
) -> anyhow::Result<()> {
    if belt_runtime.progress.is_empty() {
        return Ok(());
    }
    let routes = &prepared_routes.routes;
    let quantum_bandwidth = crate::quantum_logistics::runtime_bandwidth(base, entities);
    let mut quantum_session = None;
    let belt_limit = normalized_buffer_limit(
        base.get("settings")
            .and_then(Value::as_object)
            .and_then(|settings| settings.get("beltBufferLimit")),
    );
    advance_belt_clocks(belt_runtime, routes, seconds, belt_limit)?;
    let mut post_actions = vec![BeltPostAction::None; belt_runtime.progress.len()];
    let mut target_free = vec![f64::NAN; prepared_routes.target_slot_count];
    let mut groups = prepared_routes
        .groups
        .iter()
        .map(|group| -> anyhow::Result<Group> {
            let item_id = state
                .symbols
                .resolve(group.item_symbol)
                .ok_or_else(|| anyhow!("native prepared belt item is missing"))?;
            let source = entities[group.source_index]
                .as_object()
                .expect("validated source");
            Ok(Group {
                available: (output_amount(source, item_id) + EPSILON).floor(),
                source_had_output: source
                    .get("outputs")
                    .and_then(Value::as_object)
                    .is_some_and(|outputs| outputs.contains_key(item_id)),
                first_candidate: None,
                candidates: Vec::new(),
                first_inactive_route: None,
                inactive_routes: Vec::new(),
            })
        })
        .collect::<anyhow::Result<Vec<_>>>()?;

    for (route_index, route) in routes.iter().enumerate() {
        let index = route.source_group;
        if groups[index].available < 1.0 {
            if !defer_source_depletion_reset {
                post_actions[route.belt_index] = BeltPostAction::ResetProgress;
            }
            continue;
        }
        let target = entities[route.target_index]
            .as_object()
            .ok_or_else(|| anyhow!("native belt target is not an object"))?;
        let item_id = state
            .symbols
            .resolve(prepared_routes.groups[route.source_group].item_symbol)
            .ok_or_else(|| anyhow!("native prepared belt item is missing"))?;
        if target_free[route.target_slot].is_nan() {
            target_free[route.target_slot] = target_capacity(
                state,
                base,
                &mut quantum_session,
                entities,
                target,
                item_id,
                route.target_port_index,
            )?
            .floor()
            .max(0.0);
        }
        if target_free[route.target_slot] < 1.0 {
            post_actions[route.belt_index] = BeltPostAction::ResetProgress;
            continue;
        }
        let cap = allowance_caps
            .and_then(|caps| caps.get(route.belt_index).copied())
            .filter(|value| value.is_finite())
            .unwrap_or(9_007_199_254_740_991.0);
        let allowance = (belt_runtime.progress[route.belt_index] + EPSILON)
            .floor()
            .min(cap);
        if allowance < 1.0 {
            if groups[index].first_inactive_route.is_none() {
                groups[index].first_inactive_route = Some(route_index);
            } else {
                groups[index].inactive_routes.push(route_index);
            }
            continue;
        }
        let candidate = Candidate {
            route_index,
            allowance,
            moved: 0.0,
        };
        if groups[index].first_candidate.is_none() {
            groups[index].first_candidate = Some(candidate);
        } else {
            groups[index].candidates.push(candidate);
        }
    }

    for (group_index, group) in groups.iter_mut().enumerate() {
        let prepared_group = &prepared_routes.groups[group_index];
        let item_id = state
            .symbols
            .resolve(prepared_group.item_symbol)
            .ok_or_else(|| anyhow!("native prepared belt item is missing"))?;
        let Some(first_candidate) = group.first_candidate.take() else {
            if group.source_had_output || group.available > 0.0 {
                set_output(
                    entities[prepared_group.source_index]
                        .as_object_mut()
                        .ok_or_else(|| anyhow!("native belt source is not an object"))?,
                    item_id,
                    group.available,
                )?;
            }
            for route_index in group
                .first_inactive_route
                .iter()
                .copied()
                .chain(group.inactive_routes.iter().copied())
            {
                let route = &routes[route_index];
                post_actions[route.belt_index] = BeltPostAction::Flow {
                    available: group.available,
                    free: target_free[route.target_slot],
                    moved: 0.0,
                };
            }
            continue;
        };
        if group.candidates.is_empty() {
            let route = &routes[first_candidate.route_index];
            let free = target_free[route.target_slot];
            let requested = group
                .available
                .min(first_candidate.allowance)
                .min(free)
                .floor()
                .max(0.0);
            let moved = if requested > 0.0 {
                move_to_target(
                    state,
                    base,
                    entities,
                    quantum_bandwidth,
                    &mut quantum_session,
                    route,
                    item_id,
                    requested,
                )?
            } else {
                0.0
            };
            let available = (group.available - moved).max(0.0);
            if moved > 0.0 {
                target_free[route.target_slot] -= moved;
                set_number(
                    entities[prepared_group.source_index]
                        .as_object_mut()
                        .ok_or_else(|| anyhow!("native belt source is not an object"))?,
                    "routingCursor",
                    0.0,
                )?;
            }
            if group.source_had_output || group.available > 0.0 {
                set_output(
                    entities[prepared_group.source_index]
                        .as_object_mut()
                        .ok_or_else(|| anyhow!("native belt source is not an object"))?,
                    item_id,
                    available,
                )?;
            }
            post_actions[route.belt_index] = BeltPostAction::Flow {
                available,
                free: target_free[route.target_slot],
                moved,
            };
            for route_index in group
                .first_inactive_route
                .iter()
                .copied()
                .chain(group.inactive_routes.iter().copied())
            {
                let inactive_route = &routes[route_index];
                post_actions[inactive_route.belt_index] = BeltPostAction::Flow {
                    available,
                    free: target_free[inactive_route.target_slot],
                    moved: 0.0,
                };
            }
            continue;
        }
        group.candidates.push(first_candidate);
        group
            .candidates
            .sort_by_key(|candidate| routes[candidate.route_index].belt_sort_rank);
        let mut available = group.available;
        let priorities: &[usize] =
            if group.candidates.len() == 1 || prepared_group.balanced_splitter {
                &[3]
            } else {
                &[2, 1, 0]
            };
        for &priority in priorities {
            let candidate_indexes = group
                .candidates
                .iter()
                .enumerate()
                .filter_map(|(index, candidate)| {
                    let route = &routes[candidate.route_index];
                    (priority == 3 || route.priority == priority).then_some(index)
                })
                .collect::<Vec<_>>();
            let usable = candidate_indexes
                .into_iter()
                .filter(|&index| {
                    let route = &routes[group.candidates[index].route_index];
                    group.candidates[index].allowance > 0.0 && target_free[route.target_slot] > 0.0
                })
                .collect::<Vec<_>>();
            if usable.is_empty() || available <= 0.0 {
                continue;
            }
            if usable.len() == 1 {
                let index = usable[0];
                let candidate = &mut group.candidates[index];
                let route = &routes[candidate.route_index];
                let free = target_free[route.target_slot];
                let requested = available
                    .min(candidate.allowance)
                    .min(free)
                    .floor()
                    .max(0.0);
                if requested > 0.0 {
                    let moved = move_to_target(
                        state,
                        base,
                        entities,
                        quantum_bandwidth,
                        &mut quantum_session,
                        route,
                        item_id,
                        requested,
                    )?;
                    if moved <= 0.0 {
                        continue;
                    }
                    target_free[route.target_slot] -= moved;
                    candidate.allowance -= moved;
                    candidate.moved += moved;
                    available -= moved;
                    set_number(
                        entities[prepared_group.source_index]
                            .as_object_mut()
                            .ok_or_else(|| anyhow!("native belt source is not an object"))?,
                        "routingCursor",
                        0.0,
                    )?;
                }
                continue;
            }
            let source_cursor = finite_number(
                entities[prepared_group.source_index]
                    .as_object()
                    .and_then(|source| source.get("routingCursor")),
            )
            .floor()
            .max(0.0) as usize;
            let mut cursor = source_cursor % usable.len();
            while available > 0.0 {
                let active = usable
                    .iter()
                    .copied()
                    .filter(|&index| {
                        let route = &routes[group.candidates[index].route_index];
                        group.candidates[index].allowance > 0.0
                            && target_free[route.target_slot] > 0.0
                    })
                    .collect::<Vec<_>>();
                if active.is_empty() {
                    break;
                }
                let start = cursor % active.len();
                let fair_share = (available / active.len() as f64).floor().max(1.0);
                let mut successful = 0;
                for offset in 0..active.len() {
                    if available <= 0.0 {
                        break;
                    }
                    let index = active[(start + offset) % active.len()];
                    let candidate = &mut group.candidates[index];
                    let route = &routes[candidate.route_index];
                    let free = target_free[route.target_slot];
                    let requested = available
                        .min(fair_share)
                        .min(candidate.allowance)
                        .min(free)
                        .floor()
                        .max(0.0);
                    if requested <= 0.0 {
                        continue;
                    }
                    let moved = move_to_target(
                        state,
                        base,
                        entities,
                        quantum_bandwidth,
                        &mut quantum_session,
                        route,
                        item_id,
                        requested,
                    )?;
                    if moved <= 0.0 {
                        continue;
                    }
                    target_free[route.target_slot] -= moved;
                    candidate.allowance -= moved;
                    candidate.moved += moved;
                    available -= moved;
                    successful += 1;
                    cursor = (cursor + 1) % usable.len();
                }
                if successful == 0 {
                    break;
                }
            }
            set_number(
                entities[prepared_group.source_index]
                    .as_object_mut()
                    .ok_or_else(|| anyhow!("native belt source is not an object"))?,
                "routingCursor",
                cursor as f64,
            )?;
            if available <= 0.0 {
                break;
            }
        }

        // The JS active-route queue does not materialize a missing output key
        // when a completely idle source has no cargo. Preserve that sparse
        // object shape; once a key existed (including a positive source that
        // was drained to zero), it must still be written back.
        if group.source_had_output || group.available > 0.0 {
            set_output(
                entities[prepared_group.source_index]
                    .as_object_mut()
                    .ok_or_else(|| anyhow!("native belt source is not an object"))?,
                item_id,
                available,
            )?;
        }
        for candidate in &group.candidates {
            let route = &routes[candidate.route_index];
            let free = target_free[route.target_slot];
            post_actions[route.belt_index] = BeltPostAction::Flow {
                available,
                free,
                moved: candidate.moved,
            };
        }
        for route_index in group
            .first_inactive_route
            .iter()
            .copied()
            .chain(group.inactive_routes.iter().copied())
        {
            let route = &routes[route_index];
            let free = target_free[route.target_slot];
            post_actions[route.belt_index] = BeltPostAction::Flow {
                available,
                free,
                moved: 0.0,
            };
        }
    }
    apply_belt_post_actions(
        belt_runtime,
        routes,
        &post_actions,
        seconds,
        defer_source_depletion_reset,
        flow_window_seconds,
    )?;
    crate::quantum_logistics::finish_supply_deposit_session(base, quantum_session)
}

pub(crate) fn reserve(
    state: &CoreState,
    base: &Map<String, Value>,
    entities: &[Value],
    belt_runtime: &BeltRuntime,
    prepared_routes: &PreparedRoutes,
) -> anyhow::Result<BeltStepReservation> {
    let routes = &prepared_routes.routes;
    let belt_limit = normalized_buffer_limit(
        base.get("settings")
            .and_then(Value::as_object)
            .and_then(|settings| settings.get("beltBufferLimit")),
    );
    let mut result = BeltStepReservation {
        allowance_by_belt: vec![f64::NAN; belt_runtime.progress.len()],
        output_credits: HashMap::new(),
    };
    let mut quantum_session = None;
    let mut target_free = vec![f64::NAN; prepared_routes.target_slot_count];
    for route in routes {
        let allowance = (belt_runtime.progress[route.belt_index] + EPSILON)
            .floor()
            .max(0.0);
        if allowance < 1.0 {
            continue;
        }
        let target = entities[route.target_index]
            .as_object()
            .ok_or_else(|| anyhow!("native belt target is not an object"))?;
        let prepared_group = &prepared_routes.groups[route.source_group];
        let item_id = state
            .symbols
            .resolve(prepared_group.item_symbol)
            .ok_or_else(|| anyhow!("native prepared belt item is missing"))?;
        if target_free[route.target_slot].is_nan() {
            target_free[route.target_slot] = target_capacity(
                state,
                base,
                &mut quantum_session,
                entities,
                target,
                item_id,
                route.target_port_index,
            )?
            .floor()
            .max(0.0);
        }
        let free = target_free[route.target_slot];
        let reserved = allowance.min(free.floor().max(0.0));
        if reserved < 1.0 {
            continue;
        }
        result.allowance_by_belt[route.belt_index] = reserved;
        target_free[route.target_slot] -= reserved;
        let credit = result
            .output_credits
            .entry((prepared_group.source_index, prepared_group.item_symbol))
            .or_default();
        *credit = (*credit + reserved).min(belt_limit);
    }
    Ok(result)
}

pub(crate) fn output_credit(
    state: &CoreState,
    credits: &OutputCredits,
    entity_id: &str,
    item_id: &str,
) -> f64 {
    let Some(entity_index) = state.entity_index.get(entity_id).copied() else {
        return 0.0;
    };
    let Some(item_symbol) = state.symbols.lookup(item_id) else {
        return 0.0;
    };
    credits
        .get(&(entity_index, item_symbol))
        .copied()
        .unwrap_or(0.0)
}

pub(crate) fn aggregate_flow(state: &CoreState, belts: &[Value]) -> anyhow::Result<(f64, f64)> {
    if belts.len() != state.belts.ids.len() {
        bail!("native belt aggregate topology changed");
    }
    let mut capacity = 0.0;
    let mut flow = 0.0;
    for (index, belt) in belts.iter().enumerate() {
        let belt = belt
            .as_object()
            .ok_or_else(|| anyhow!("native belt record is not an object"))?;
        let tier = state.belts.tiers[index];
        let speed = state
            .catalog
            .belt_speeds
            .get(&tier)
            .copied()
            .with_context(|| format!("native belt tier {tier} is missing"))?;
        capacity += speed
            * state.belts.lanes[index].floor()
            * state.belts.stack_sizes[index].max(1.0).floor();
        flow += finite_number(belt.get("lastFlow")).max(0.0);
    }
    if !capacity.is_finite() || !flow.is_finite() {
        bail!("native belt aggregate is non-finite");
    }
    Ok((capacity, flow))
}
