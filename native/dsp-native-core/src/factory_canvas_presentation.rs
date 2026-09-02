//! Projection-only entity presentation for the Windows factory canvas.
//!
//! This module is intentionally read-only. It consumes one already-decoded
//! entity plus immutable catalog/base references and returns a disposable UI
//! sidecar. Nothing here is persisted, hashed, or accepted as command input.

use std::collections::HashSet;

use serde_json::{Map, Value, json};

use crate::catalog::{BuildingDefinition, RecipeDefinition, RuntimeCatalog};

const MAX_ITEM_ROWS: usize = 32;
const MAX_LABEL_BYTES: usize = 256;
const MIN_BUILDING_BUFFER_LIMIT: f64 = 1_000.0;
const DEFAULT_BUILDING_BUFFER_LIMIT: f64 = 1_000_000.0;
const MAX_BUILDING_BUFFER_LIMIT: f64 = 100_000_000.0;
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
const EPSILON: f64 = 1e-9;
const MATRIX_ITEM_IDS: [&str; 6] = [
    "electromagnetic_matrix",
    "energy_matrix",
    "structure_matrix",
    "information_matrix",
    "gravity_matrix",
    "universe_matrix",
];
const ACTIVITY_MATERIAL_IDS: [&str; 4] = [
    "universe_matrix",
    "solar_sail",
    "small_carrier_rocket",
    "antimatter_fuel_rod",
];

#[derive(Clone, Copy)]
struct Status<'a> {
    code: &'a str,
    label: &'a str,
    tone: &'a str,
}

impl Status<'_> {
    fn to_value(self) -> Value {
        json!({
            "code": self.code,
            "label": self.label,
            "tone": self.tone,
        })
    }
}

fn unsupported(entity_id: &str) -> Value {
    json!({ "entityId": entity_id, "supported": false })
}

fn finite_nonnegative(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value >= 0.0)
}

fn object_number(object: &Map<String, Value>, key: &str) -> f64 {
    finite_nonnegative(object.get(key)).unwrap_or(0.0)
}

fn bounded_label(value: &str) -> String {
    if value.len() <= MAX_LABEL_BYTES && !value.contains('\0') {
        return value.to_owned();
    }
    let mut result = String::new();
    for character in value.chars() {
        if character == '\0' || result.len() + character.len_utf8() > MAX_LABEL_BYTES - 3 {
            break;
        }
        result.push(character);
    }
    result.push('…');
    result
}

fn item_label(catalog: &RuntimeCatalog, item_id: &str) -> String {
    let value = catalog
        .items
        .get(item_id)
        .map(|item| item.name.as_str())
        .filter(|name| !name.is_empty())
        .unwrap_or(item_id);
    bounded_label(value)
}

fn inventory_is_proven(value: Option<&Value>, catalog: &RuntimeCatalog) -> bool {
    value.and_then(Value::as_object).is_some_and(|inventory| {
        inventory.iter().all(|(item_id, amount)| {
            catalog.items.contains_key(item_id)
                && amount
                    .as_f64()
                    .is_some_and(|amount| amount.is_finite() && amount >= 0.0)
        })
    })
}

fn inventory_amount(entity: &Map<String, Value>, field: &str, item_id: &str) -> f64 {
    entity
        .get(field)
        .and_then(Value::as_object)
        .and_then(|inventory| inventory.get(item_id))
        .and_then(Value::as_f64)
        .filter(|amount| amount.is_finite() && *amount >= 0.0)
        .unwrap_or(0.0)
}

fn push_item(
    rows: &mut Vec<String>,
    seen: &mut HashSet<String>,
    catalog: &RuntimeCatalog,
    item_id: &str,
) -> Option<()> {
    if !catalog.items.contains_key(item_id) || item_id.is_empty() || item_id.contains('\0') {
        return None;
    }
    if seen.insert(item_id.to_owned()) {
        if rows.len() >= MAX_ITEM_ROWS {
            return None;
        }
        rows.push(item_id.to_owned());
    }
    Some(())
}

fn entity_item_ids(
    entity: &Map<String, Value>,
    catalog: &RuntimeCatalog,
    produced: bool,
) -> Option<Vec<String>> {
    let kind = entity.get("kind")?.as_str()?;
    let building_id = entity.get("buildingId").and_then(Value::as_str);
    let mut rows = Vec::new();
    let mut seen = HashSet::new();
    let mut add = |item_id: &str| push_item(&mut rows, &mut seen, catalog, item_id);

    if produced
        && building_id.is_some_and(|id| {
            matches!(
                id,
                "material_delivery_hub"
                    | "construction_center"
                    | "galactic_material_exporter"
                    | "micro_black_hole_connector"
                    | "time_warp_device"
            )
        })
    {
        return Some(rows);
    }
    if !produced && building_id == Some("galactic_material_exporter") {
        for item_id in ACTIVITY_MATERIAL_IDS {
            add(item_id)?;
        }
        return Some(rows);
    }
    if !produced && building_id == Some("orbital_cargo_terminal") {
        if let Some(item_ids) = entity
            .get("orbitalCargoPortItems")
            .and_then(Value::as_array)
        {
            for item_id in item_ids {
                match item_id {
                    Value::Null => {}
                    Value::String(item_id) => add(item_id)?,
                    _ => return None,
                }
            }
        }
        return Some(rows);
    }
    // The connector accepts the complete item directory. A large built-in
    // directory cannot be represented by this deliberately bounded sidecar,
    // so fail closed instead of silently returning an incomplete topology.
    if !produced && building_id == Some("micro_black_hole_connector") {
        if catalog.items.len() > MAX_ITEM_ROWS {
            return None;
        }
        let mut item_ids = catalog.items.keys().map(String::as_str).collect::<Vec<_>>();
        item_ids.sort_unstable();
        for item_id in item_ids {
            add(item_id)?;
        }
        return Some(rows);
    }
    if kind == "vein" {
        if produced {
            add(entity.get("resourceId")?.as_str()?)?;
        }
        return Some(rows);
    }
    if kind == "station" && building_id != Some("orbital_collector") {
        if let Some(slots) = entity.get("stationSlots").and_then(Value::as_array) {
            for slot in slots {
                match slot.get("itemId") {
                    None | Some(Value::Null) => {}
                    Some(Value::String(item_id)) => add(item_id)?,
                    _ => return None,
                }
            }
        } else if let Some(item_id) = entity.get("storedItemId").and_then(Value::as_str) {
            add(item_id)?;
        }
        return Some(rows);
    }
    if matches!(kind, "storage" | "splitter" | "station") {
        if !produced && building_id == Some("material_delivery_hub") {
            if let Some(slots) = entity.get("deliverySlots").and_then(Value::as_array) {
                for slot in slots {
                    match slot.get("itemId") {
                        None | Some(Value::Null) => {}
                        Some(Value::String(item_id)) => add(item_id)?,
                        _ => return None,
                    }
                }
            } else if let Some(item_ids) = entity.get("deliveryItemIds").and_then(Value::as_array) {
                for item_id in item_ids {
                    add(item_id.as_str()?)?;
                }
            }
            return Some(rows);
        }
        if let Some(item_id) = entity.get("storedItemId").and_then(Value::as_str) {
            add(item_id)?;
        }
        return Some(rows);
    }
    if !produced && building_id == Some("thermal_power_plant") {
        if let Some(item_id) = entity.get("fuelItemId").and_then(Value::as_str) {
            add(item_id)?;
        }
        return Some(rows);
    }

    let recipe = entity
        .get("recipeId")
        .and_then(Value::as_str)
        .and_then(|recipe_id| catalog.recipes.get(recipe_id));
    if !produced && recipe.is_some_and(|recipe| recipe.id == "matrix_research") {
        for item_id in MATRIX_ITEM_IDS {
            add(item_id)?;
        }
    } else if let Some(recipe) = recipe {
        for amount in if produced {
            &recipe.outputs
        } else {
            &recipe.inputs
        } {
            add(&amount.item_id)?;
        }
    }
    if !produced && entity.get("sprayCoaterInstalled").and_then(Value::as_bool) == Some(true) {
        let tier = entity.get("proliferatorTier")?.as_u64()?;
        let tier = u8::try_from(tier).ok()?;
        add(&catalog.proliferators.get(&tier)?.item_id)?;
    }
    Some(rows)
}

fn normalized_buffer_limit(base: &Map<String, Value>, logistics: bool) -> f64 {
    let key = if logistics {
        "logisticsBufferLimit"
    } else {
        "productionBufferLimit"
    };
    base.get("settings")
        .and_then(Value::as_object)
        .and_then(|settings| settings.get(key))
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .unwrap_or(DEFAULT_BUILDING_BUFFER_LIMIT)
        .floor()
        .clamp(MIN_BUILDING_BUFFER_LIMIT, MAX_BUILDING_BUFFER_LIMIT)
}

fn stacked_capacity(base_capacity: f64, count: f64, limit: f64) -> f64 {
    let base_capacity = base_capacity.max(0.0).floor();
    let count = count.max(1.0).floor();
    if base_capacity <= 0.0 {
        0.0
    } else if base_capacity > limit / count {
        limit
    } else {
        (base_capacity * count).min(limit)
    }
}

fn extractor_id(resource_id: &str) -> &'static str {
    match resource_id {
        "crude_oil" => "oil_extractor",
        "water" | "sulfuric_acid" => "water_pump",
        _ => "mining_machine",
    }
}

fn output_capacity(
    base: &Map<String, Value>,
    entity: &Map<String, Value>,
    catalog: &RuntimeCatalog,
) -> Option<f64> {
    let kind = entity.get("kind")?.as_str()?;
    let logistics = matches!(kind, "storage" | "splitter" | "station");
    let limit = normalized_buffer_limit(base, logistics);
    let definition = if let Some(building_id) = entity.get("buildingId").and_then(Value::as_str) {
        Some((
            catalog.buildings.get(building_id)?,
            object_number(entity, "machineCount"),
        ))
    } else if kind == "vein" {
        let resource_id = entity.get("resourceId")?.as_str()?;
        let extractor = entity
            .get("extractorBuildingId")
            .and_then(Value::as_str)
            .unwrap_or_else(|| extractor_id(resource_id));
        Some((
            catalog.buildings.get(extractor)?,
            object_number(entity, "minerCount"),
        ))
    } else {
        None
    };
    Some(definition.map_or(0.0, |(building, count)| {
        stacked_capacity(building.output_capacity, count, limit)
    }))
}

fn power_factor(base: &Map<String, Value>, entity: &Map<String, Value>) -> f64 {
    if entity.get("buildingId").and_then(Value::as_str) == Some("orbital_collector") {
        return 1.0;
    }
    let direct = entity
        .get("powerFactor")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite());
    let planet_id = entity.get("planetId").and_then(Value::as_str);
    let grid_id = entity
        .get("powerGridId")
        .and_then(Value::as_str)
        .unwrap_or("grid-a");
    let grid = planet_id
        .and_then(|planet_id| base.get("powerGridMetrics")?.get(planet_id))
        .and_then(|planet| planet.get(grid_id))
        .and_then(|grid| grid.get("powerFactor"))
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite());
    let planet = planet_id
        .and_then(|planet_id| base.get("planetMetrics")?.get(planet_id))
        .and_then(|metrics| metrics.get("powerFactor"))
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite());
    direct.or(grid).or(planet).unwrap_or(1.0).clamp(0.0, 1.0)
}

fn vein_utilization_level(base: &Map<String, Value>) -> f64 {
    base.get("endgame")
        .and_then(|value| value.get("infiniteResearch"))
        .and_then(|value| value.get("vein_utilization"))
        .and_then(|value| value.get("level"))
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value >= 0.0)
        .unwrap_or(0.0)
        .floor()
        .min(1_000.0)
}

fn resource_reserve(
    base: &Map<String, Value>,
    entity: &Map<String, Value>,
    catalog: &RuntimeCatalog,
) -> Option<Value> {
    if entity.get("kind").and_then(Value::as_str)? != "vein" {
        return Some(Value::Null);
    }
    let resource_id = entity.get("resourceId")?.as_str()?;
    let item = catalog.items.get(resource_id)?;
    let planet_id = entity.get("planetId")?.as_str()?;
    let ocean_type = base
        .get("galaxy")
        .and_then(|galaxy| galaxy.get("profiles"))
        .and_then(|profiles| profiles.get(planet_id))
        .and_then(|profile| profile.get("oceanType"))
        .and_then(Value::as_str)
        .unwrap_or("none");
    let level = vein_utilization_level(base);
    let infinite = base
        .get("settings")
        .and_then(|settings| settings.get("resourceMode"))
        .and_then(Value::as_str)
        == Some("infinite")
        || (item.kind == "solid" && level >= 10.0)
        || (resource_id == "water" && ocean_type == "water")
        || (resource_id == "sulfuric_acid" && ocean_type == "sulfuric-acid");
    if infinite {
        return Some(json!({
            "infinite": true,
            "exhausted": false,
            "remaining": Value::Null,
            "capacity": Value::Null,
            "remainingRatio": 1.0,
            "remainingPercent": 100,
        }));
    }
    let remaining = finite_nonnegative(entity.get("resourceRemaining"))?
        .floor()
        .min(MAX_SAFE_INTEGER);
    let capacity = finite_nonnegative(entity.get("resourceCapacity"))
        .unwrap_or(remaining)
        .floor()
        .max(remaining)
        .min(MAX_SAFE_INTEGER);
    let ratio = if capacity > 0.0 {
        (remaining / capacity).clamp(0.0, 1.0)
    } else {
        0.0
    };
    let consumption_tenths = if item.kind == "solid" {
        (10.0 - level.min(10.0)).max(0.0).floor()
    } else {
        10.0
    };
    let remainder = finite_nonnegative(entity.get("resourceDepletionRemainder"))
        .unwrap_or(0.0)
        .floor()
        .clamp(0.0, 9.0);
    let allowance = if consumption_tenths <= 0.0 {
        f64::INFINITY
    } else {
        ((remaining * 10.0 - remainder).max(0.0) / consumption_tenths).floor()
    };
    Some(json!({
        "infinite": false,
        "exhausted": allowance < 1.0,
        "remaining": remaining,
        "capacity": capacity,
        "remainingRatio": ratio,
        "remainingPercent": (ratio * 100.0).round(),
    }))
}

fn cycle_rate_per_second(
    base: &Map<String, Value>,
    entity: &Map<String, Value>,
    building: Option<&BuildingDefinition>,
    recipe: Option<&RecipeDefinition>,
    power_factor: f64,
) -> f64 {
    if base.get("paused").and_then(Value::as_bool).unwrap_or(false)
        || object_number(entity, "utilization") <= EPSILON
    {
        return 0.0;
    }
    let production_rate = object_number(entity, "productionRate") / 60.0;
    if entity.get("kind").and_then(Value::as_str) == Some("vein") {
        return production_rate.max(0.0);
    }
    let Some(building) = building else {
        return production_rate.max(0.0);
    };
    let Some(recipe) = recipe else {
        return production_rate.max(0.0);
    };
    let count = object_number(entity, "machineCount").max(1.0).floor();
    let rated = if recipe.duration > EPSILON {
        building.speed.max(0.0) * count * power_factor / recipe.duration
    } else {
        0.0
    };
    let units_per_cycle = recipe
        .outputs
        .iter()
        .map(|output| output.amount.max(0.0))
        .sum::<f64>();
    if production_rate > EPSILON && units_per_cycle > EPSILON {
        rated.min(production_rate / units_per_cycle).max(0.0)
    } else {
        0.0
    }
}

fn target_dyson_orbit_label(
    base: &Map<String, Value>,
    entity: &Map<String, Value>,
    catalog: &RuntimeCatalog,
) -> Option<String> {
    let target_id = entity.get("targetDysonOrbitId")?.as_str()?;
    if target_id.is_empty() || target_id.contains('\0') {
        return None;
    }
    let planet_id = entity.get("planetId")?.as_str()?;
    let system_id = catalog
        .planets
        .iter()
        .find(|planet| planet.id == planet_id)?
        .system_id
        .as_str();
    let orbit = base
        .get("dysonEngineering")
        .and_then(|engineering| engineering.get("orbitsBySystem"))
        .and_then(|systems| systems.get(system_id))
        .and_then(Value::as_array)
        .and_then(|orbits| {
            orbits
                .iter()
                .find(|orbit| orbit.get("id").and_then(Value::as_str) == Some(target_id))
        });
    let label = orbit
        .and_then(|orbit| orbit.get("name"))
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .map(|name| format!("轨道：{name}"))
        .unwrap_or_else(|| "轨道失效".to_owned());
    Some(bounded_label(&label))
}

fn status_after_power(power_factor: f64, running_label: &'static str) -> Value {
    if power_factor <= EPSILON {
        Status {
            code: "no-power",
            label: "未获得电网供电",
            tone: "blocked",
        }
        .to_value()
    } else if power_factor < 0.999 {
        Status {
            code: "low-power",
            label: "供电不足",
            tone: "warning",
        }
        .to_value()
    } else {
        Status {
            code: "running",
            label: running_label,
            tone: "running",
        }
        .to_value()
    }
}

#[allow(clippy::too_many_arguments)]
fn status(
    base: &Map<String, Value>,
    entity: &Map<String, Value>,
    catalog: &RuntimeCatalog,
    recipe: Option<&RecipeDefinition>,
    capacity: f64,
    resource_reserve: &Value,
    power_factor: f64,
    accepted_inputs: &[String],
) -> Value {
    if base.get("paused").and_then(Value::as_bool).unwrap_or(false) {
        return Status {
            code: "paused",
            label: "模拟已暂停",
            tone: "idle",
        }
        .to_value();
    }
    let kind = entity
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let building_id = entity.get("buildingId").and_then(Value::as_str);
    let entity_id = entity.get("id").and_then(Value::as_str).unwrap_or_default();
    if kind == "vein" {
        if resource_reserve.get("exhausted").and_then(Value::as_bool) == Some(true) {
            return Status {
                code: "resource-depleted",
                label: "资源已枯竭",
                tone: "blocked",
            }
            .to_value();
        }
        if object_number(entity, "minerCount") < 1.0 {
            return Status {
                code: "idle",
                label: "等待采集设施",
                tone: "idle",
            }
            .to_value();
        }
        let resource_id = entity
            .get("resourceId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if inventory_amount(entity, "outputs", resource_id) >= capacity - EPSILON {
            return Status {
                code: "output-blocked",
                label: "输出缓存已满",
                tone: "blocked",
            }
            .to_value();
        }
        if power_factor <= EPSILON {
            return Status {
                code: "no-power",
                label: "未获得电网供电",
                tone: "blocked",
            }
            .to_value();
        }
        if power_factor < 0.999 {
            return Status {
                code: "low-power",
                label: "供电不足",
                tone: "warning",
            }
            .to_value();
        }
        return Status {
            code: "running",
            label: "采矿中",
            tone: "running",
        }
        .to_value();
    }
    if kind == "power" {
        if let Some(building_id) = building_id
            && let Some(building) = catalog.buildings.get(building_id)
            && !building.fuel_item_ids.is_empty()
        {
            let Some(fuel_item_id) = entity.get("fuelItemId").and_then(Value::as_str) else {
                return Status {
                    code: "no-fuel-selected",
                    label: "未选择燃料",
                    tone: "blocked",
                }
                .to_value();
            };
            if inventory_amount(entity, "inputs", fuel_item_id) < 1.0
                && object_number(entity, "fuelRemainingMj") <= EPSILON
            {
                return Status {
                    code: "missing-fuel",
                    label: "燃料不足",
                    tone: "blocked",
                }
                .to_value();
            }
        }
        return Status {
            code: "running",
            label: "能源设施运行中",
            tone: "running",
        }
        .to_value();
    }
    if building_id == Some("orbital_cargo_terminal") {
        if entity.get("orbitalCargoBinding").is_none_or(Value::is_null) {
            return Status {
                code: "unconfigured",
                label: "未绑定空间站建设或出口合同",
                tone: "blocked",
            }
            .to_value();
        }
        let buffered = accepted_inputs
            .iter()
            .any(|item_id| inventory_amount(entity, "inputs", item_id) >= 1.0);
        if !buffered {
            return Status {
                code: "missing-input",
                label: "等待绑定目标所需物资",
                tone: "idle",
            }
            .to_value();
        }
        return status_after_power(power_factor, "向全星系空间站上传物资");
    }
    if building_id == Some("orbital_collector") {
        let Some(item_id) = accepted_inputs.first() else {
            return Status {
                code: "unconfigured",
                label: "未选择轨道采集物品",
                tone: "blocked",
            }
            .to_value();
        };
        if inventory_amount(entity, "outputs", item_id) >= capacity - EPSILON {
            return Status {
                code: "output-blocked",
                label: "轨道采集库存已满",
                tone: "blocked",
            }
            .to_value();
        }
        return Status {
            code: "collecting",
            label: "轨道资源采集中",
            tone: "running",
        }
        .to_value();
    }
    if matches!(kind, "storage" | "splitter" | "station") {
        if accepted_inputs.is_empty() {
            return Status {
                code: "unconfigured",
                label: "未配置物流物品",
                tone: "blocked",
            }
            .to_value();
        }
        let buffered = accepted_inputs.iter().any(|item_id| {
            inventory_amount(entity, "inputs", item_id) > EPSILON
                || inventory_amount(entity, "outputs", item_id) > EPSILON
        });
        return if buffered {
            Status {
                code: "idle",
                label: "等待线路继续搬运",
                tone: "idle",
            }
            .to_value()
        } else {
            Status {
                code: "missing-input",
                label: "等待物料",
                tone: "idle",
            }
            .to_value()
        };
    }
    if building_id == Some("construction_center") {
        if base
            .get("constructionAutomation")
            .and_then(|automation| automation.get("enabled"))
            .and_then(Value::as_bool)
            != Some(true)
        {
            return Status {
                code: "paused",
                label: "自动制造已关闭",
                tone: "idle",
            }
            .to_value();
        }
        let active_job = base
            .get("constructionAutomation")
            .and_then(|automation| automation.get("jobs"))
            .and_then(|jobs| jobs.get(entity_id))
            .is_some_and(|job| !job.is_null());
        if !active_job {
            return Status {
                code: "grid-standby",
                label: "等待制造任务",
                tone: "idle",
            }
            .to_value();
        }
        return status_after_power(power_factor, "制造任务处理中");
    }
    if building_id == Some("galactic_material_exporter") {
        if entity
            .get("galacticExporterPaused")
            .and_then(Value::as_bool)
            != Some(false)
        {
            return Status {
                code: "paused",
                label: "银河物资出口已暂停",
                tone: "idle",
            }
            .to_value();
        }
        let buffered = accepted_inputs
            .iter()
            .any(|item_id| inventory_amount(entity, "inputs", item_id) >= 1.0);
        if !buffered {
            return Status {
                code: "missing-input",
                label: "等待四类银河工程物资",
                tone: "idle",
            }
            .to_value();
        }
        return status_after_power(power_factor, "银河物资交付中");
    }
    if building_id == Some("micro_black_hole_connector") {
        if entity.get("blackHolePaused").and_then(Value::as_bool) != Some(false) {
            return Status {
                code: "paused",
                label: "微型黑洞已暂停",
                tone: "idle",
            }
            .to_value();
        }
        if entity
            .get("blackHoleActivationConfirmed")
            .and_then(Value::as_bool)
            != Some(true)
        {
            return Status {
                code: "paused",
                label: "等待二次确认启动",
                tone: "warning",
            }
            .to_value();
        }
        return Status {
            code: "missing-input",
            label: "等待连接物资输入",
            tone: "idle",
        }
        .to_value();
    }
    if building_id == Some("time_warp_device") {
        let time_warp = base.get("timeWarp");
        if time_warp
            .and_then(|value| value.get("controllerEntityId"))
            .and_then(Value::as_str)
            != Some(entity_id)
        {
            return Status {
                code: "grid-standby",
                label: "非主控装置",
                tone: "idle",
            }
            .to_value();
        }
        if time_warp
            .and_then(|value| value.get("enabled"))
            .and_then(Value::as_bool)
            != Some(true)
        {
            return Status {
                code: "paused",
                label: "时间扭曲已暂停",
                tone: "idle",
            }
            .to_value();
        }
        let effective = time_warp
            .and_then(|value| value.get("effectiveMultiplier"))
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite() && *value >= 0.0)
            .unwrap_or(0.0);
        let simulation_speed = base
            .get("settings")
            .and_then(|value| value.get("simulationSpeed"))
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite() && *value >= 0.0)
            .unwrap_or(1.0);
        if effective <= simulation_speed {
            return Status {
                code: "no-power",
                label: "时间扭曲供电不足",
                tone: "blocked",
            }
            .to_value();
        }
        return Status {
            code: "running",
            label: "全局时间扭曲运行中",
            tone: "running",
        }
        .to_value();
    }
    let Some(recipe) = recipe else {
        return Status {
            code: "missing-recipe",
            label: "未选择配方",
            tone: "blocked",
        }
        .to_value();
    };
    if recipe.id == "matrix_research"
        && base
            .get("research")
            .and_then(|research| research.get("selectedTechId"))
            .is_none_or(Value::is_null)
    {
        return Status {
            code: "missing-research",
            label: "未选择研究科技",
            tone: "blocked",
        }
        .to_value();
    }
    if let Some(required_tech_id) = recipe.required_tech_id.as_deref()
        && !base
            .get("research")
            .and_then(|research| research.get("completedTechIds"))
            .and_then(Value::as_array)
            .is_some_and(|completed| {
                completed
                    .iter()
                    .any(|tech_id| tech_id.as_str() == Some(required_tech_id))
            })
    {
        return Status {
            code: "missing-recipe",
            label: "配方科技未解锁",
            tone: "blocked",
        }
        .to_value();
    }
    if matches!(
        recipe.id.as_str(),
        "solar_sail_launch" | "carrier_rocket_launch"
    ) && base
        .get("dysonEngineering")
        .and_then(|engineering| engineering.get("launchEnabled"))
        .and_then(Value::as_bool)
        == Some(false)
    {
        return Status {
            code: "launch-paused",
            label: "戴森发射调度已暂停",
            tone: "idle",
        }
        .to_value();
    }
    if recipe.id == "solar_sail_launch"
        && target_dyson_orbit_label(base, entity, catalog)
            .as_deref()
            .is_none_or(|label| label == "轨道失效")
    {
        return Status {
            code: "missing-dyson-orbit",
            label: "未指定太阳帆目标轨道",
            tone: "blocked",
        }
        .to_value();
    }
    let blocked = recipe.outputs.iter().any(|output| {
        inventory_amount(entity, "outputs", &output.item_id) + output.amount > capacity + EPSILON
    });
    if blocked {
        return Status {
            code: "output-blocked",
            label: "输出缓存已满",
            tone: "blocked",
        }
        .to_value();
    }
    let missing = recipe
        .inputs
        .iter()
        .find(|input| inventory_amount(entity, "inputs", &input.item_id) + EPSILON < input.amount);
    if let Some(input) = missing {
        let label = bounded_label(&format!("缺少{}", item_label(catalog, &input.item_id)));
        return json!({ "code": "missing-input", "label": label, "tone": "blocked" });
    }
    if power_factor <= EPSILON {
        return Status {
            code: "no-power",
            label: "未获得电网供电",
            tone: "blocked",
        }
        .to_value();
    }
    if power_factor < 0.999 {
        return Status {
            code: "low-power",
            label: "供电不足",
            tone: "warning",
        }
        .to_value();
    }
    Status {
        code: "running",
        label: "运行中",
        tone: "running",
    }
    .to_value()
}

fn building_and_recipe<'a>(
    entity: &Map<String, Value>,
    catalog: &'a RuntimeCatalog,
) -> Option<(Option<&'a BuildingDefinition>, Option<&'a RecipeDefinition>)> {
    let kind = entity.get("kind")?.as_str()?;
    if !matches!(
        kind,
        "vein" | "machine" | "power" | "storage" | "splitter" | "station"
    ) {
        return None;
    }
    let building = match entity.get("buildingId") {
        None | Some(Value::Null) if kind == "vein" => None,
        Some(Value::String(building_id)) => {
            let building = catalog.buildings.get(building_id)?;
            if building.kind != kind && !(kind == "vein" && building.kind == "miner") {
                return None;
            }
            Some(building)
        }
        None | Some(Value::Null) => None,
        _ => return None,
    };
    let recipe = match entity.get("recipeId") {
        None | Some(Value::Null) => None,
        Some(Value::String(recipe_id)) => {
            let recipe = catalog.recipes.get(recipe_id)?;
            if let Some(building) = building
                && recipe.building_id != building.id
            {
                return None;
            }
            Some(recipe)
        }
        _ => return None,
    };
    Some((building, recipe))
}

/// Builds one presentation row for an entity that has already been decoded by
/// the viewport projection. Any unprovable content-pack or record semantics
/// fail closed to the strict two-field unsupported shape.
pub(crate) fn project_entity(
    identity_registry_fingerprint: &str,
    catalog: &RuntimeCatalog,
    base: &Map<String, Value>,
    entity: &Value,
) -> Value {
    let Some(entity) = entity.as_object() else {
        return unsupported("");
    };
    let entity_id = entity.get("id").and_then(Value::as_str).unwrap_or_default();
    if identity_registry_fingerprint != catalog.snapshot.registry_fingerprint
        || !catalog.data_only_native_supported
        || entity_id.is_empty()
        || entity_id.contains('\0')
        || !inventory_is_proven(entity.get("inputs"), catalog)
        || !inventory_is_proven(entity.get("outputs"), catalog)
    {
        return unsupported(entity_id);
    }
    let Some((building, recipe)) = building_and_recipe(entity, catalog) else {
        return unsupported(entity_id);
    };
    if entity.get("kind").and_then(Value::as_str) == Some("vein") {
        let Some(resource_id) = entity.get("resourceId").and_then(Value::as_str) else {
            return unsupported(entity_id);
        };
        if !catalog.items.contains_key(resource_id) {
            return unsupported(entity_id);
        }
    }
    let Some(accepted_inputs) = entity_item_ids(entity, catalog, false) else {
        return unsupported(entity_id);
    };
    let Some(produced_outputs) = entity_item_ids(entity, catalog, true) else {
        return unsupported(entity_id);
    };
    let Some(output_capacity) = output_capacity(base, entity, catalog) else {
        return unsupported(entity_id);
    };
    let Some(resource_reserve) = resource_reserve(base, entity, catalog) else {
        return unsupported(entity_id);
    };
    let power_factor = power_factor(base, entity);
    let cycle_rate = cycle_rate_per_second(base, entity, building, recipe, power_factor)
        .clamp(0.0, MAX_SAFE_INTEGER);
    let status = status(
        base,
        entity,
        catalog,
        recipe,
        output_capacity,
        &resource_reserve,
        power_factor,
        &accepted_inputs,
    );
    json!({
        "entityId": entity_id,
        "supported": true,
        "coverage": "conservative",
        "status": status,
        "powerFactor": power_factor,
        "resourceReserve": resource_reserve,
        "outputCapacity": output_capacity,
        "cycleRatePerSecond": cycle_rate,
        "acceptedInputItemIds": accepted_inputs,
        "producedOutputItemIds": produced_outputs,
        "targetDysonOrbitLabel": target_dyson_orbit_label(base, entity, catalog),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::{
        BeltDefinition, BuildingDefinition, CatalogSnapshot, ItemDefinition, PlanetDefinition,
    };
    use std::collections::HashMap;

    const EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT: &str = "7df8cf3a";

    fn catalog(registry_fingerprint: &str) -> RuntimeCatalog {
        RuntimeCatalog::validate(
            CatalogSnapshot {
                protocol_version: 1,
                registry_fingerprint: registry_fingerprint.to_owned(),
                planets: vec![PlanetDefinition {
                    id: "home".to_owned(),
                    name: "home".to_owned(),
                    system_id: "helios".to_owned(),
                    kind: "terrestrial".to_owned(),
                    orbit_index: 1,
                    simulation_order: 0,
                    orbital_yields: HashMap::new(),
                }],
                items: vec![ItemDefinition {
                    id: "iron_ore".to_owned(),
                    name: "铁矿".to_owned(),
                    kind: "solid".to_owned(),
                    fuel_energy_mj: 0.0,
                }],
                buildings: vec![BuildingDefinition {
                    id: "mining_machine".to_owned(),
                    kind: "miner".to_owned(),
                    speed: 1.0,
                    input_capacity: 0.0,
                    output_capacity: 50.0,
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
            registry_fingerprint,
        )
        .unwrap()
    }

    #[test]
    fn built_in_vein_presentation_is_bounded_and_read_only() {
        let catalog = catalog(EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT);
        let base = json!({
            "paused": false,
            "settings": { "resourceMode": "finite", "productionBufferLimit": 1_000 },
            "endgame": { "infiniteResearch": { "vein_utilization": { "level": 0 } } },
            "galaxy": { "profiles": { "home": { "oceanType": "none" } } }
        });
        let entity = json!({
            "id": "vein-1", "kind": "vein", "planetId": "home",
            "resourceId": "iron_ore", "extractorBuildingId": "mining_machine",
            "minerCount": 2, "powerFactor": 0.5, "resourceRemaining": 25,
            "resourceCapacity": 100, "resourceDepletionRemainder": 0,
            "inputs": {}, "outputs": { "iron_ore": 3 },
            "utilization": 0.5, "productionRate": 120
        });
        let before = entity.clone();
        let row = project_entity(
            EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT,
            &catalog,
            base.as_object().unwrap(),
            &entity,
        );

        assert_eq!(entity, before);
        assert_eq!(row["entityId"], "vein-1");
        assert_eq!(row["supported"], true);
        assert_eq!(row["coverage"], "conservative");
        assert_eq!(row["powerFactor"], 0.5);
        assert_eq!(row["outputCapacity"], 100.0);
        assert_eq!(row["cycleRatePerSecond"], 2.0);
        assert_eq!(row["resourceReserve"]["remainingPercent"], 25.0);
        assert_eq!(row["acceptedInputItemIds"], json!([]));
        assert_eq!(row["producedOutputItemIds"], json!(["iron_ore"]));
    }

    #[test]
    fn mod_or_unproven_semantics_use_the_strict_unsupported_shape() {
        let catalog = catalog("modded-registry");
        let base = Map::new();
        let row = project_entity(
            "modded-registry",
            &catalog,
            &base,
            &json!({
                "id": "MOD/entity", "kind": "vein", "planetId": "home",
                "resourceId": "iron_ore", "inputs": {}, "outputs": {}
            }),
        );
        assert_eq!(row, json!({ "entityId": "MOD/entity", "supported": false }));
    }

    #[test]
    fn registered_data_only_custom_building_has_a_normal_factory_presentation() {
        let catalog = RuntimeCatalog::from_value(
            json!({
                "protocolVersion": 1,
                "registryFingerprint": "modded-registry",
                "planets": [{ "id": "home", "name": "母星", "systemId": "helios", "kind": "terrestrial", "orbitIndex": 1 }],
                "items": [
                    { "id": "mod_ore", "name": "模组矿", "kind": "solid" },
                    { "id": "mod_ingot", "name": "模组锭", "kind": "solid" }
                ],
                "buildings": [{
                    "id": "mod_smelter", "name": "模组熔炉", "shortName": "模炉", "description": "数据型建筑",
                    "kind": "machine", "speed": 2, "inputCapacity": 100, "outputCapacity": 200,
                    "stackLimit": 64, "stackLimitComplete": true,
                    "layoutWidth": 360, "layoutHeight": 240, "layoutClearance": 30,
                    "ports": [
                        { "index": 0, "direction": "input", "accepts": "solid", "maxConnections": 4 },
                        { "index": 0, "direction": "output", "accepts": "solid", "maxConnections": 4 }
                    ],
                    "capabilities": ["ordinary-production"]
                }],
                "recipes": [{
                    "id": "mod_smelt", "name": "模组冶炼", "buildingId": "mod_smelter", "duration": 2,
                    "inputs": [{ "itemId": "mod_ore", "amount": 2 }],
                    "outputs": [{ "itemId": "mod_ingot", "amount": 1 }]
                }],
                "constructions": [{
                    "id": "mod_smelter", "outputAmount": 1,
                    "costs": [{ "itemId": "mod_ingot", "amount": 2 }]
                }],
                "belts": [],
                "technologies": []
            }),
            "modded-registry",
        )
        .unwrap();
        let base = json!({
            "paused": false,
            "settings": { "resourceMode": "finite", "productionBufferLimit": 1_000 },
            "research": { "completedTechIds": [] },
            "endgame": { "infiniteResearch": {} },
            "galaxy": { "profiles": { "home": { "oceanType": "none" } } }
        });
        let entity = json!({
            "id": "mod-entity", "kind": "machine", "planetId": "home",
            "buildingId": "mod_smelter", "recipeId": "mod_smelt", "machineCount": 2,
            "powerFactor": 1, "progress": 0.5, "utilization": 1, "productionRate": 120,
            "inputs": { "mod_ore": 3 }, "outputs": { "mod_ingot": 1 }
        });
        let row = project_entity(
            "modded-registry",
            &catalog,
            base.as_object().unwrap(),
            &entity,
        );
        assert_eq!(row["entityId"], "mod-entity");
        assert_eq!(row["supported"], true);
        assert_eq!(row["acceptedInputItemIds"], json!(["mod_ore"]));
        assert_eq!(row["producedOutputItemIds"], json!(["mod_ingot"]));
        assert_eq!(row["outputCapacity"], 400.0);
        assert_eq!(row["cycleRatePerSecond"], 2.0);
    }
}
