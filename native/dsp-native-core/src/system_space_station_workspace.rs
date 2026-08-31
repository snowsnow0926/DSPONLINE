//! Bounded read-only projection for one built-in system space station.
//!
//! This projection is deliberately narrower than the simulation domain. It
//! exposes only player-visible construction, module, shared-inventory,
//! interstellar-station mode/output, and planet-tray facts for one catalog
//! star system. Contracts, the global orbital-station extension, MOD content,
//! route ledgers, decorations, and mutation results never cross this boundary.

use std::collections::{BTreeSet, HashSet};

use anyhow::{anyhow, bail};
use num_bigint::BigUint;
use num_traits::{ToPrimitive, Zero};
use serde_json::{Map, Value, json};

use crate::state::CoreState;

const SYSTEM_SPACE_STATION_WORKSPACE_SCHEMA: &str = "system-space-station-workspace-v1";
const MAX_REQUEST_BYTES: usize = 32_768;
const MAX_PROJECTION_BYTES: usize = 1_048_576;
const MAX_PAGE_ROWS: usize = 64;
const MAX_TOTAL_ROWS: usize = 65_536;
const MAX_SESSION_ID_BYTES: usize = 128;
const MAX_RUN_ID_BYTES: usize = 128;
const MAX_OPAQUE_ID_BYTES: usize = 512;
const MAX_LABEL_BYTES: usize = 512;
const MAX_DECIMAL_DIGITS: usize = 256;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_MODULE_COUNT: u64 = 1_000_000;

const CONSTRUCTION_PHASES: [(&str, &str, u64); 16] = [
    ("轨道基座", "titanium_alloy", 1_000_000),
    ("轨道基座", "frame_material", 500_000),
    ("轨道基座", "small_carrier_rocket", 100_000),
    ("轨道基座", "universe_matrix", 100_000),
    ("主体框架", "frame_material", 2_000_000),
    ("主体框架", "dyson_sphere_component", 1_000_000),
    ("主体框架", "titanium_glass", 1_000_000),
    ("主体框架", "quantum_chip", 500_000),
    ("能源核心", "antimatter_fuel_rod", 250_000),
    ("能源核心", "annihilation_constraint_sphere", 500_000),
    ("能源核心", "strange_matter", 1_000_000),
    ("能源核心", "plane_filter", 1_000_000),
    ("调度核心", "processor", 5_000_000),
    ("调度核心", "particle_broadband", 2_000_000),
    ("调度核心", "quantum_chip", 2_000_000),
    ("调度核心", "universe_matrix", 1_000_000),
];

fn valid_opaque_text(value: &str, maximum_bytes: usize) -> bool {
    !value.is_empty() && value.len() <= maximum_bytes && !value.chars().any(char::is_control)
}

fn bounded_label(candidate: Option<&str>, fallback: &str) -> (String, bool) {
    let source = candidate
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback);
    if source.len() <= MAX_LABEL_BYTES && !source.chars().any(char::is_control) {
        return (source.to_owned(), false);
    }
    let mut result = String::new();
    for character in source.chars() {
        if character.is_control() || result.len() + character.len_utf8() > MAX_LABEL_BYTES {
            break;
        }
        result.push(character);
    }
    if result.is_empty() {
        (fallback.to_owned(), true)
    } else {
        (result, true)
    }
}

fn required_object<'a>(
    value: Option<&'a Value>,
    label: &str,
) -> anyhow::Result<&'a Map<String, Value>> {
    value
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native system station workspace {label} is invalid"))
}

fn optional_object<'a>(
    value: Option<&'a Value>,
    label: &str,
) -> anyhow::Result<Option<&'a Map<String, Value>>> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Object(object)) => Ok(Some(object)),
        Some(_) => bail!("native system station workspace {label} is invalid"),
    }
}

fn ensure_known_keys(
    object: &Map<String, Value>,
    allowed: &[&str],
    label: &str,
) -> anyhow::Result<()> {
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        bail!("native system station workspace {label} contains an unknown field");
    }
    Ok(())
}

fn safe_integer(value: Option<&Value>, label: &str) -> anyhow::Result<u64> {
    value
        .and_then(Value::as_u64)
        .filter(|value| *value <= MAX_SAFE_INTEGER)
        .ok_or_else(|| anyhow!("native system station workspace {label} is invalid"))
}

fn optional_safe_integer(value: Option<&Value>, fallback: u64, label: &str) -> anyhow::Result<u64> {
    match value {
        None | Some(Value::Null) => Ok(fallback),
        Some(value) => safe_integer(Some(value), label),
    }
}

fn decimal(value: Option<&Value>, label: &str) -> anyhow::Result<BigUint> {
    let text = value
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("native system station workspace {label} is invalid"))?;
    if text.is_empty()
        || text.len() > MAX_DECIMAL_DIGITS
        || !text.bytes().all(|byte| byte.is_ascii_digit())
    {
        bail!("native system station workspace {label} is invalid");
    }
    BigUint::parse_bytes(text.as_bytes(), 10)
        .ok_or_else(|| anyhow!("native system station workspace {label} is invalid"))
}

fn decimal_or_zero(value: Option<&Value>, label: &str) -> anyhow::Result<BigUint> {
    match value {
        None | Some(Value::Null) => Ok(BigUint::zero()),
        Some(value) => decimal(Some(value), label),
    }
}

fn decimal_text(value: &BigUint, label: &str) -> anyhow::Result<String> {
    let text = value.to_string();
    if text.len() > MAX_DECIMAL_DIGITS {
        bail!("native system station workspace {label} exceeds the decimal bound");
    }
    Ok(text)
}

fn checked_decimal_add(target: &mut BigUint, amount: &BigUint, label: &str) -> anyhow::Result<()> {
    *target += amount;
    if target.to_string().len() > MAX_DECIMAL_DIGITS {
        bail!("native system station workspace {label} exceeds the decimal bound");
    }
    Ok(())
}

fn required_phase_amount(base_amount: u64, basis_points: u64) -> BigUint {
    BigUint::from(base_amount.saturating_mul(basis_points).div_ceil(10_000))
}

fn item_name(state: &CoreState, item_id: &str) -> anyhow::Result<(String, bool)> {
    let item = state.catalog.items.get(item_id).ok_or_else(|| {
        anyhow!("native system station workspace item is outside the built-in catalog")
    })?;
    Ok(bounded_label(Some(&item.name), item_id))
}

fn item_record<'a>(
    state: &CoreState,
    record: Option<&'a Map<String, Value>>,
    label: &str,
) -> anyhow::Result<Option<&'a Map<String, Value>>> {
    let Some(record) = record else {
        return Ok(None);
    };
    for item_id in record.keys() {
        if !valid_opaque_text(item_id, MAX_OPAQUE_ID_BYTES)
            || !state.catalog.items.contains_key(item_id)
        {
            bail!("native system station workspace {label} contains unsupported content");
        }
    }
    Ok(Some(record))
}

fn string_array_contains(value: Option<&Value>, needle: &str, label: &str) -> anyhow::Result<bool> {
    let values = value
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("native system station workspace {label} is invalid"))?;
    let mut seen = HashSet::with_capacity(values.len());
    for value in values {
        let value = value
            .as_str()
            .filter(|value| valid_opaque_text(value, MAX_OPAQUE_ID_BYTES))
            .ok_or_else(|| anyhow!("native system station workspace {label} is invalid"))?;
        if !seen.insert(value) {
            bail!("native system station workspace {label} contains duplicates");
        }
    }
    Ok(seen.contains(needle))
}

fn validate_page(cursor: usize, limit: usize) -> anyhow::Result<()> {
    if cursor > u32::MAX as usize || !(1..=MAX_PAGE_ROWS).contains(&limit) {
        bail!("native system station workspace page request is invalid");
    }
    Ok(())
}

fn page(cursor: usize, limit: usize, rows: &[Value], label: &str) -> anyhow::Result<Value> {
    if rows.len() > MAX_TOTAL_ROWS || cursor > rows.len() {
        bail!("native system station workspace {label} page is invalid");
    }
    let end = cursor.saturating_add(limit).min(rows.len());
    Ok(json!({
        "cursor": cursor,
        "limit": limit,
        "totalCount": rows.len(),
        "nextCursor": (end < rows.len()).then_some(end),
        "rows": rows[cursor..end].to_vec(),
    }))
}

fn system_display_name(state: &CoreState, system_id: &str) -> (String, bool) {
    let candidate = state
        .base_value()
        .get("galaxy")
        .and_then(Value::as_object)
        .and_then(|galaxy| galaxy.get("systemMetadata"))
        .and_then(Value::as_object)
        .and_then(|metadata| metadata.get(system_id))
        .and_then(Value::as_object)
        .and_then(|metadata| metadata.get("customName"))
        .and_then(Value::as_str);
    bounded_label(candidate, system_id)
}

fn persisted_station<'a>(
    base: &'a Map<String, Value>,
    system_id: &str,
) -> anyhow::Result<Option<&'a Map<String, Value>>> {
    let directory = required_object(base.get("systemSpaceStations"), "station directory")?;
    match directory.get(system_id) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Object(station)) => Ok(Some(station)),
        Some(_) => bail!("native system station workspace station record is invalid"),
    }
}

fn default_station(system_id: &str) -> Value {
    json!({
        "systemId": system_id,
        "status": "not-started",
        "costRevision": 0,
        "costMultiplierBasisPoints": 10_000,
        "phaseIndex": 0,
        "delivered": {},
        "constructionBuffer": {},
        "inventory": {},
        "itemPolicies": {},
        "modules": { "backbone": 0, "energy": 0, "interstellar": 0 },
        "routingCursors": {},
        "viewport": { "x": 0, "y": 0, "zoom": 0.85 },
        "decorations": [],
    })
}

fn module_count(modules: &Map<String, Value>, key: &str) -> anyhow::Result<u64> {
    let value = safe_integer(modules.get(key), "module count")?;
    if value > MAX_MODULE_COUNT {
        bail!("native system station workspace module count exceeds the bound");
    }
    Ok(value)
}

fn station_rows(
    state: &CoreState,
    system_id: &str,
    planet_ids: &HashSet<&str>,
) -> anyhow::Result<(Vec<Value>, usize, usize, usize, usize, bool)> {
    let mut rows = Vec::new();
    let mut mk1_count = 0usize;
    let mut mk2_count = 0usize;
    let mut elevator_count = 0usize;
    let mut transitioning_count = 0usize;
    let mut launcher_present = false;
    for entity_index in 0..state.entity_index.len() {
        let entity = state.parse_entity(entity_index)?;
        let Some(entity) = entity.as_object() else {
            bail!("native system station workspace entity is invalid");
        };
        let building_id = entity.get("buildingId").and_then(Value::as_str);
        if building_id == Some("space_station_construction_launcher") {
            launcher_present |= entity
                .get("planetId")
                .and_then(Value::as_str)
                .is_some_and(|planet_id| planet_ids.contains(planet_id));
        }
        if building_id != Some("interstellar_logistics_station") {
            continue;
        }
        let planet_id = entity
            .get("planetId")
            .and_then(Value::as_str)
            .filter(|planet_id| valid_opaque_text(planet_id, MAX_OPAQUE_ID_BYTES))
            .ok_or_else(|| anyhow!("native system station workspace station planet is invalid"))?;
        if !planet_ids.contains(planet_id) {
            continue;
        }
        let entity_id = entity
            .get("id")
            .and_then(Value::as_str)
            .filter(|entity_id| valid_opaque_text(entity_id, MAX_OPAQUE_ID_BYTES))
            .ok_or_else(|| anyhow!("native system station workspace station ID is invalid"))?;
        if entity.get("kind").and_then(Value::as_str) != Some("station") {
            bail!("native system station workspace interstellar station kind is invalid");
        }
        let machine_count = safe_integer(entity.get("machineCount"), "station machine count")?;
        if machine_count == 0 {
            bail!("native system station workspace station machine count is invalid");
        }
        let station_tier = optional_safe_integer(entity.get("stationTier"), 1, "station tier")?;
        if !matches!(station_tier, 1 | 2) {
            bail!("native system station workspace station tier is invalid");
        }
        let operation_mode = match entity.get("stationOperationMode") {
            None | Some(Value::Null) => "legacy",
            Some(Value::String(mode)) if matches!(mode.as_str(), "legacy" | "elevator") => mode,
            Some(_) => bail!("native system station workspace station mode is invalid"),
        };
        let transition = match entity.get("stationModeTransition") {
            None | Some(Value::Null) => None,
            Some(Value::String(transition))
                if matches!(transition.as_str(), "to-elevator" | "to-legacy") =>
            {
                Some(transition.as_str())
            }
            Some(_) => bail!("native system station workspace station mode transition is invalid"),
        };
        if station_tier == 1 && (operation_mode != "legacy" || transition.is_some()) {
            bail!("native system station workspace Mk.I mode state is invalid");
        }
        let mut output_items = Vec::<Option<String>>::with_capacity(5);
        match entity.get("elevatorOutputItems") {
            None | Some(Value::Null) => output_items.resize(5, None),
            Some(Value::Array(items)) if items.len() == 5 => {
                let mut seen = HashSet::new();
                for item in items {
                    match item {
                        Value::Null => output_items.push(None),
                        Value::String(item_id)
                            if valid_opaque_text(item_id, MAX_OPAQUE_ID_BYTES)
                                && state.catalog.items.contains_key(item_id)
                                && seen.insert(item_id.as_str()) =>
                        {
                            output_items.push(Some(item_id.clone()));
                        }
                        _ => bail!("native system station workspace output target is invalid"),
                    }
                }
            }
            Some(_) => bail!("native system station workspace output target list is invalid"),
        }
        let output_targets = output_items
            .iter()
            .enumerate()
            .map(|(port_index, item_id)| {
                let (item_name, item_name_truncated) = item_id
                    .as_deref()
                    .map(|item_id| item_name(state, item_id))
                    .transpose()?
                    .unwrap_or_else(|| (String::new(), false));
                Ok::<Value, anyhow::Error>(json!({
                    "portIndex": port_index,
                    "itemId": item_id,
                    "itemName": item_name,
                    "itemNameTruncated": item_name_truncated,
                }))
            })
            .collect::<anyhow::Result<Vec<_>>>()?;
        let planet = state
            .catalog
            .planets
            .iter()
            .find(|planet| planet.id == planet_id && planet.system_id == system_id)
            .ok_or_else(|| anyhow!("native system station workspace station planet is missing"))?;
        let (planet_name, planet_name_truncated) = bounded_label(Some(&planet.name), planet_id);
        let effective_mode = match transition {
            Some("to-elevator") => "elevator",
            Some("to-legacy") => "legacy",
            _ => operation_mode,
        };
        if station_tier == 1 {
            mk1_count += 1;
        } else {
            mk2_count += 1;
        }
        if operation_mode == "elevator" {
            elevator_count += 1;
        }
        if transition.is_some() {
            transitioning_count += 1;
        }
        rows.push(json!({
            "entityId": entity_id,
            "planetId": planet_id,
            "planetName": planet_name,
            "planetNameTruncated": planet_name_truncated,
            "machineCount": machine_count,
            "stationTier": station_tier,
            "operationMode": operation_mode,
            "modeTransition": transition,
            "effectiveTargetMode": effective_mode,
            "outputTargets": output_targets,
            "outputConfigurationEnabled": station_tier == 2 && operation_mode == "elevator" && transition.is_none(),
        }));
    }
    if rows.len() > MAX_TOTAL_ROWS {
        bail!("native system station workspace contains too many station rows");
    }
    Ok((
        rows,
        mk1_count,
        mk2_count,
        elevator_count,
        transitioning_count,
        launcher_present,
    ))
}

#[allow(clippy::too_many_arguments)]
impl CoreState {
    /// Returns four independently pageable lanes for one built-in star system.
    /// The caller-owned session/run lineage is echoed into both the request
    /// proof and the response so a thin renderer cannot merge stale pages.
    pub fn system_space_station_workspace_projection(
        &self,
        session_id: &str,
        run_id: &str,
        expected_revision: u64,
        expected_registry_fingerprint: &str,
        system_id: &str,
        requirement_cursor: usize,
        requirement_limit: usize,
        inventory_cursor: usize,
        inventory_limit: usize,
        tray_cursor: usize,
        tray_limit: usize,
        station_cursor: usize,
        station_limit: usize,
    ) -> anyhow::Result<Value> {
        if self.identity.state_version != 47
            || self.base_value().get("version").and_then(Value::as_u64) != Some(47)
            || self.base_value().get("mode").and_then(Value::as_str) != Some("normal")
            || expected_revision != self.revision
            || expected_registry_fingerprint != self.catalog.snapshot.registry_fingerprint
            || !valid_opaque_text(session_id, MAX_SESSION_ID_BYTES)
            || !valid_opaque_text(run_id, MAX_RUN_ID_BYTES)
            || !valid_opaque_text(system_id, MAX_OPAQUE_ID_BYTES)
        {
            bail!("native system station workspace identity is invalid");
        }
        for (cursor, limit) in [
            (requirement_cursor, requirement_limit),
            (inventory_cursor, inventory_limit),
            (tray_cursor, tray_limit),
            (station_cursor, station_limit),
        ] {
            validate_page(cursor, limit)?;
        }
        let request = json!({
            "sessionId": session_id,
            "runId": run_id,
            "expectedRevision": expected_revision,
            "expectedRegistryFingerprint": expected_registry_fingerprint,
            "systemId": system_id,
            "requirementCursor": requirement_cursor,
            "requirementLimit": requirement_limit,
            "inventoryCursor": inventory_cursor,
            "inventoryLimit": inventory_limit,
            "trayCursor": tray_cursor,
            "trayLimit": tray_limit,
            "stationCursor": station_cursor,
            "stationLimit": station_limit,
        });
        if serde_json::to_vec(&request)?.len() > MAX_REQUEST_BYTES {
            bail!("native system station workspace request exceeds the byte limit");
        }
        let base = self.base_value();
        match base.get("contentPacks") {
            Some(Value::Array(packs)) if packs.is_empty() => {}
            Some(Value::Array(_)) => {
                bail!("native system station workspace does not support content packs")
            }
            _ => bail!("native system station workspace content-pack state is invalid"),
        }
        let planets = self
            .catalog
            .planets
            .iter()
            .filter(|planet| planet.system_id == system_id)
            .collect::<Vec<_>>();
        if planets.is_empty() {
            bail!("native system station workspace system is unavailable");
        }
        let planet_ids = planets
            .iter()
            .map(|planet| planet.id.as_str())
            .collect::<HashSet<_>>();
        let active_planet_id = base
            .get("activePlanetId")
            .and_then(Value::as_str)
            .filter(|value| valid_opaque_text(value, MAX_OPAQUE_ID_BYTES))
            .ok_or_else(|| anyhow!("native system station workspace active planet is invalid"))?;
        if !self
            .catalog
            .planets
            .iter()
            .any(|planet| planet.id == active_planet_id)
        {
            bail!("native system station workspace active planet is unavailable");
        }
        let (display_name, display_name_truncated) = system_display_name(self, system_id);

        let persisted = persisted_station(base, system_id)?;
        let default_value = default_station(system_id);
        let station = persisted.unwrap_or_else(|| {
            default_value
                .as_object()
                .expect("default system station is an object")
        });
        if station.get("systemId").and_then(Value::as_str) != Some(system_id) {
            bail!("native system station workspace station identity is invalid");
        }
        let status = station
            .get("status")
            .and_then(Value::as_str)
            .filter(|status| matches!(*status, "not-started" | "building" | "operational"))
            .ok_or_else(|| anyhow!("native system station workspace station status is invalid"))?;
        let cost_revision = safe_integer(station.get("costRevision"), "cost revision")?;
        let cost_multiplier_basis_points =
            safe_integer(station.get("costMultiplierBasisPoints"), "cost multiplier")?;
        if !(8_000..=10_000).contains(&cost_multiplier_basis_points) {
            bail!("native system station workspace cost multiplier is invalid");
        }
        let phase_index = safe_integer(station.get("phaseIndex"), "phase index")? as usize;
        if phase_index > CONSTRUCTION_PHASES.len() {
            bail!("native system station workspace phase index is invalid");
        }
        let delivered = item_record(
            self,
            Some(required_object(
                station.get("delivered"),
                "delivered record",
            )?),
            "delivered record",
        )?
        .expect("required delivered record exists");
        let construction_buffer = item_record(
            self,
            Some(required_object(
                station.get("constructionBuffer"),
                "construction buffer",
            )?),
            "construction buffer",
        )?
        .expect("required construction buffer exists");
        let inventory = item_record(
            self,
            Some(required_object(station.get("inventory"), "inventory")?),
            "inventory",
        )?
        .expect("required inventory exists");
        let item_policies = item_record(
            self,
            Some(required_object(
                station.get("itemPolicies"),
                "item policies",
            )?),
            "item policies",
        )?
        .expect("required item policy record exists");
        let modules = required_object(station.get("modules"), "modules")?;
        ensure_known_keys(modules, &["backbone", "energy", "interstellar"], "modules")?;
        let backbone_modules = module_count(modules, "backbone")?;
        let energy_modules = module_count(modules, "energy")?;
        let interstellar_modules = module_count(modules, "interstellar")?;
        for value in delivered.values() {
            decimal(Some(value), "delivered construction amount")?;
        }

        let mut total_required = BigUint::zero();
        let mut total_delivered = BigUint::zero();
        let mut total_buffered = BigUint::zero();
        let mut requirement_rows = Vec::with_capacity(CONSTRUCTION_PHASES.len());
        let mut requirement_item_ids = BTreeSet::new();
        let current_phase_name = CONSTRUCTION_PHASES
            .get(phase_index)
            .map(|(phase_name, _, _)| *phase_name);
        for (index, (phase_name, item_id, base_amount)) in
            CONSTRUCTION_PHASES.iter().copied().enumerate()
        {
            let required = required_phase_amount(base_amount, cost_multiplier_basis_points);
            let delivered_amount =
                decimal_or_zero(delivered.get(item_id), "delivered construction amount")?;
            let buffered_amount = decimal_or_zero(
                construction_buffer.get(item_id),
                "buffered construction amount",
            )?;
            let credited = delivered_amount.clone().min(required.clone());
            checked_decimal_add(&mut total_required, &required, "total required amount")?;
            checked_decimal_add(&mut total_delivered, &credited, "total delivered amount")?;
            requirement_item_ids.insert(item_id);
            let (item_display_name, item_name_truncated) = item_name(self, item_id)?;
            requirement_rows.push(json!({
                "requirementIndex": index,
                "phaseName": phase_name,
                "itemId": item_id,
                "itemName": item_display_name,
                "itemNameTruncated": item_name_truncated,
                "baseAmount": base_amount,
                "requiredAmount": decimal_text(&required, "required amount")?,
                "deliveredAmount": decimal_text(&delivered_amount, "delivered amount")?,
                "constructionBufferAmount": decimal_text(&buffered_amount, "buffered amount")?,
                "complete": delivered_amount >= required,
                "current": current_phase_name == Some(phase_name),
            }));
        }
        for value in construction_buffer.values() {
            let amount = decimal(Some(value), "buffered construction amount")?;
            checked_decimal_add(&mut total_buffered, &amount, "total buffered amount")?;
        }

        let mut inventory_keys = BTreeSet::new();
        inventory_keys.extend(inventory.keys().map(String::as_str));
        inventory_keys.extend(item_policies.keys().map(String::as_str));
        let mut inventory_total = BigUint::zero();
        let mut inventory_rows = Vec::with_capacity(inventory_keys.len());
        for item_id in inventory_keys {
            let amount = decimal_or_zero(inventory.get(item_id), "shared inventory amount")?;
            checked_decimal_add(&mut inventory_total, &amount, "shared inventory total")?;
            let policy = if let Some(policy) = item_policies.get(item_id) {
                let policy = required_object(Some(policy), "item policy")?;
                ensure_known_keys(
                    policy,
                    &["interstellarEnabled", "reserve", "target"],
                    "item policy",
                )?;
                let enabled = policy
                    .get("interstellarEnabled")
                    .and_then(Value::as_bool)
                    .ok_or_else(|| {
                        anyhow!("native system station workspace item policy flag is invalid")
                    })?;
                let reserve = decimal(policy.get("reserve"), "item policy reserve")?;
                let target = decimal(policy.get("target"), "item policy target")?;
                Some(json!({
                    "interstellarEnabled": enabled,
                    "reserve": decimal_text(&reserve, "item policy reserve")?,
                    "target": decimal_text(&target, "item policy target")?,
                }))
            } else {
                None
            };
            let (item_display_name, item_name_truncated) = item_name(self, item_id)?;
            inventory_rows.push(json!({
                "itemId": item_id,
                "itemName": item_display_name,
                "itemNameTruncated": item_name_truncated,
                "amount": decimal_text(&amount, "shared inventory amount")?,
                "policy": policy,
            }));
        }

        let planet_trays = required_object(base.get("planetTrays"), "planet tray directory")?;
        let mut tray_rows = Vec::new();
        let mut tray_total = BigUint::zero();
        for planet in &planets {
            let empty_tray = Map::new();
            let tray = optional_object(planet_trays.get(&planet.id), "planet tray")?
                .unwrap_or(&empty_tray);
            item_record(self, Some(tray), "planet tray")?;
            let mut item_ids = BTreeSet::new();
            item_ids.extend(tray.keys().map(String::as_str));
            item_ids.extend(requirement_item_ids.iter().copied());
            for item_id in item_ids {
                let amount = match tray.get(item_id) {
                    None | Some(Value::Null) => 0,
                    Some(value) => safe_integer(Some(value), "planet tray amount")?,
                };
                checked_decimal_add(&mut tray_total, &BigUint::from(amount), "system tray total")?;
                let (item_display_name, item_name_truncated) = item_name(self, item_id)?;
                let (planet_name, planet_name_truncated) =
                    bounded_label(Some(&planet.name), &planet.id);
                tray_rows.push(json!({
                    "planetId": planet.id,
                    "planetName": planet_name,
                    "planetNameTruncated": planet_name_truncated,
                    "activePlanet": planet.id == active_planet_id,
                    "itemId": item_id,
                    "itemName": item_display_name,
                    "itemNameTruncated": item_name_truncated,
                    "amount": amount,
                    "constructionMaterial": requirement_item_ids.contains(item_id),
                }));
            }
        }
        if tray_rows.len() > MAX_TOTAL_ROWS {
            bail!("native system station workspace contains too many tray rows");
        }

        let (
            station_rows,
            mk1_count,
            mk2_count,
            elevator_count,
            transitioning_count,
            launcher_present,
        ) = station_rows(self, system_id, &planet_ids)?;
        let research = required_object(base.get("research"), "research state")?;
        let construction_technology_ready = string_array_contains(
            research.get("completedTechIds"),
            "system_space_station_engineering",
            "completed technology IDs",
        )?;
        let module_assembly_ready = string_array_contains(
            research.get("completedTechIds"),
            "orbital_modular_assembly",
            "completed technology IDs",
        )?;
        let autonomous_construction_ready = string_array_contains(
            research.get("completedTechIds"),
            "autonomous_station_construction",
            "completed technology IDs",
        )?;
        let orbital_bus_ready = string_array_contains(
            research.get("completedTechIds"),
            "orbital_multi_cargo_bus",
            "completed technology IDs",
        )?;
        let exploration = required_object(base.get("exploration"), "exploration state")?;
        let system_unlocked = string_array_contains(
            exploration.get("unlockedSystemIds"),
            system_id,
            "unlocked system IDs",
        )?;
        let hub_network = required_object(base.get("galacticHubNetwork"), "hub network")?;
        let fleet_installed = safe_integer(hub_network.get("fleetInstalled"), "fleet installed")?;
        let fleet_busy = safe_integer(hub_network.get("fleetBusy"), "fleet busy")?;
        if fleet_busy > fleet_installed {
            bail!("native system station workspace hub fleet counters are invalid");
        }
        let warpers = decimal(hub_network.get("warpers"), "hub warpers")?;
        let warper_target = decimal(hub_network.get("warperTarget"), "hub warper target")?;
        let fleet_return_count = hub_network
            .get("fleetReturns")
            .and_then(Value::as_array)
            .ok_or_else(|| anyhow!("native system station workspace fleet returns are invalid"))?
            .len();
        if fleet_return_count > MAX_TOTAL_ROWS {
            bail!("native system station workspace fleet return count exceeds the bound");
        }

        let progress_basis_points = if total_required.is_zero() {
            if status == "operational" { 10_000 } else { 0 }
        } else {
            ((&total_delivered * BigUint::from(10_000u32)) / &total_required)
                .to_u64()
                .unwrap_or(10_000)
                .min(10_000)
        };
        let value = json!({
            "schemaVersion": 1,
            "projectionType": SYSTEM_SPACE_STATION_WORKSPACE_SCHEMA,
            "source": "native-core",
            "sessionId": session_id,
            "runId": run_id,
            "revision": self.revision,
            "registryFingerprint": self.catalog.snapshot.registry_fingerprint,
            "stateVersion": self.identity.state_version,
            "limits": {
                "requestBytes": MAX_REQUEST_BYTES,
                "projectionBytes": MAX_PROJECTION_BYTES,
                "pageRows": MAX_PAGE_ROWS,
                "totalRows": MAX_TOTAL_ROWS,
                "idBytes": MAX_OPAQUE_ID_BYTES,
                "labelBytes": MAX_LABEL_BYTES,
                "decimalDigits": MAX_DECIMAL_DIGITS,
            },
            "request": request,
            "system": {
                "systemId": system_id,
                "displayName": display_name,
                "displayNameTruncated": display_name_truncated,
                "planetCount": planets.len(),
                "activePlanetId": active_planet_id,
                "activePlanetInSystem": planet_ids.contains(active_planet_id),
                "unlocked": system_unlocked,
            },
            "technology": {
                "constructionReady": construction_technology_ready,
                "moduleAssemblyReady": module_assembly_ready,
                "autonomousConstructionReady": autonomous_construction_ready,
                "orbitalBusReady": orbital_bus_ready,
            },
            "station": {
                "persisted": persisted.is_some(),
                "status": status,
                "costRevision": cost_revision,
                "costMultiplierBasisPoints": cost_multiplier_basis_points,
                "phaseIndex": phase_index,
                "canStartConstruction": status == "not-started" && system_unlocked && construction_technology_ready && launcher_present,
                "launcherPresent": launcher_present,
                "modules": {
                    "backbone": backbone_modules,
                    "energy": energy_modules,
                    "interstellar": interstellar_modules,
                },
                "progress": {
                    "basisPoints": progress_basis_points,
                    "deliveredAmount": decimal_text(&total_delivered, "total delivered amount")?,
                    "requiredAmount": decimal_text(&total_required, "total required amount")?,
                    "constructionBufferAmount": decimal_text(&total_buffered, "total buffered amount")?,
                },
                "inventoryAmount": decimal_text(&inventory_total, "shared inventory total")?,
            },
            "hubNetwork": {
                "fleetInstalled": fleet_installed,
                "fleetBusy": fleet_busy,
                "fleetReturnCount": fleet_return_count,
                "warpers": decimal_text(&warpers, "hub warpers")?,
                "warperTarget": decimal_text(&warper_target, "hub warper target")?,
            },
            "summary": {
                "requirementCount": requirement_rows.len(),
                "inventoryItemCount": inventory_rows.len(),
                "trayMaterialCount": tray_rows.len(),
                "trayAvailableAmount": decimal_text(&tray_total, "system tray total")?,
                "interstellarStationCount": station_rows.len(),
                "mk1StationCount": mk1_count,
                "mk2StationCount": mk2_count,
                "elevatorStationCount": elevator_count,
                "transitioningStationCount": transitioning_count,
            },
            "requirements": page(requirement_cursor, requirement_limit, &requirement_rows, "requirements")?,
            "sharedInventory": page(inventory_cursor, inventory_limit, &inventory_rows, "inventory")?,
            "trayMaterials": page(tray_cursor, tray_limit, &tray_rows, "tray materials")?,
            "interstellarStations": page(station_cursor, station_limit, &station_rows, "stations")?,
        });
        if serde_json::to_vec(&value)?.len() > MAX_PROJECTION_BYTES {
            bail!("native system station workspace projection exceeds the byte limit");
        }
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{CORE_PROTOCOL_VERSION, CoreCheckpointIdentity, catalog::RuntimeCatalog};

    const REGISTRY: &str = "system-station-workspace-test";
    const SESSION: &str = "player-authority-session";
    const RUN: &str = "player-authority-run";

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
            "iron_ingot",
            "copper_ingot",
        ];
        RuntimeCatalog::from_value(
            json!({
                "protocolVersion": CORE_PROTOCOL_VERSION,
                "registryFingerprint": REGISTRY,
                "planets": [
                    { "id": "home", "name": "母星", "systemId": "helios", "kind": "terrestrial", "orbitIndex": 1, "simulationOrder": 0 },
                    { "id": "forge", "name": "锻造星", "systemId": "helios", "kind": "terrestrial", "orbitIndex": 2, "simulationOrder": 1 },
                    { "id": "away", "name": "远方", "systemId": "borealis", "kind": "terrestrial", "orbitIndex": 1, "simulationOrder": 2 }
                ],
                "items": item_ids.into_iter().map(|id| json!({ "id": id, "name": format!("物品-{id}"), "kind": "solid" })).collect::<Vec<_>>(),
                "buildings": [
                    { "id": "interstellar_logistics_station", "kind": "station", "speed": 1, "inputCapacity": 10000, "outputCapacity": 10000 },
                    { "id": "space_station_construction_launcher", "kind": "station", "speed": 1, "inputCapacity": 10000, "outputCapacity": 10000 }
                ],
                "recipes": [],
                "constructions": [],
                "belts": [],
                "technologies": [
                    { "id": "system_space_station_engineering", "name": "工程", "costs": [{ "itemId": "titanium_alloy", "amount": 1 }] },
                    { "id": "orbital_modular_assembly", "name": "模块", "costs": [{ "itemId": "titanium_alloy", "amount": 1 }] },
                    { "id": "autonomous_station_construction", "name": "自律", "costs": [{ "itemId": "titanium_alloy", "amount": 1 }] },
                    { "id": "orbital_multi_cargo_bus", "name": "总线", "costs": [{ "itemId": "titanium_alloy", "amount": 1 }] }
                ]
            }),
            REGISTRY,
        )
        .unwrap()
    }

    fn fixture_base() -> Map<String, Value> {
        json!({
            "version": 47,
            "mode": "normal",
            "nextId": 10,
            "activePlanetId": "home",
            "elapsedSeconds": 100,
            "paused": false,
            "contentPacks": [],
            "settings": { "simulationSpeed": 1 },
            "research": {
                "selectedTechId": null,
                "pausedTechId": null,
                "queuedTechIds": [],
                "progressByTech": {},
                "completedTechIds": [
                    "system_space_station_engineering",
                    "orbital_modular_assembly",
                    "autonomous_station_construction",
                    "orbital_multi_cargo_bus"
                ]
            },
            "exploration": {
                "unlockedSystemIds": ["helios", "borealis"],
                "colonizedPlanetIds": ["home", "forge"]
            },
            "galaxy": {
                "systemMetadata": {
                    "helios": { "customName": "太阳联合工程区" }
                }
            },
            "planetTrays": {
                "home": { "titanium_alloy": 1000000, "iron_ingot": 1234 },
                "forge": { "frame_material": 500000, "copper_ingot": 4321 },
                "away": { "iron_ingot": 999999 }
            },
            "systemSpaceStations": {
                "helios": {
                    "systemId": "helios",
                    "status": "building",
                    "costRevision": 3,
                    "costMultiplierBasisPoints": 9000,
                    "phaseIndex": 0,
                    "delivered": { "titanium_alloy": "900000", "frame_material": "250000" },
                    "constructionBuffer": { "frame_material": "100" },
                    "inventory": { "iron_ingot": "12345678901234567890", "copper_ingot": "50" },
                    "itemPolicies": {
                        "iron_ingot": { "interstellarEnabled": true, "reserve": "100", "target": "1000" }
                    },
                    "modules": { "backbone": 3, "energy": 2, "interstellar": 1 },
                    "routingCursors": {},
                    "viewport": { "x": 0, "y": 0, "zoom": 0.85 },
                    "decorations": []
                }
            },
            "galacticHubNetwork": {
                "fleetInstalled": 20,
                "fleetBusy": 7,
                "fleetReturns": [{ "routeKey": "a", "returnAtSecond": 130, "vesselCount": 2 }],
                "warpers": "98765432109876543210",
                "warperTarget": "100000000000000000000",
                "routingCursors": {}
            }
        })
        .as_object()
        .unwrap()
        .clone()
    }

    fn fixture_entities() -> Vec<Value> {
        vec![
            json!({
                "id": "launcher-home",
                "kind": "station",
                "planetId": "home",
                "buildingId": "space_station_construction_launcher",
                "machineCount": 1,
                "inputs": {},
                "outputs": {},
                "position": { "x": 0, "y": 0 }
            }),
            json!({
                "id": "station-b",
                "kind": "station",
                "planetId": "forge",
                "buildingId": "interstellar_logistics_station",
                "machineCount": 2,
                "stationTier": 1,
                "stationOperationMode": "legacy",
                "stationModeTransition": null,
                "inputs": {},
                "outputs": {},
                "position": { "x": 10, "y": 0 }
            }),
            json!({
                "id": "station-a",
                "kind": "station",
                "planetId": "home",
                "buildingId": "interstellar_logistics_station",
                "machineCount": 1,
                "stationTier": 2,
                "stationOperationMode": "elevator",
                "stationModeTransition": null,
                "elevatorOutputItems": ["iron_ingot", null, "copper_ingot", null, null],
                "inputs": {},
                "outputs": {},
                "position": { "x": 20, "y": 0 }
            }),
            json!({
                "id": "station-away",
                "kind": "station",
                "planetId": "away",
                "buildingId": "interstellar_logistics_station",
                "machineCount": 1,
                "stationTier": 2,
                "stationOperationMode": "legacy",
                "stationModeTransition": "to-elevator",
                "elevatorOutputItems": [null, null, null, null, null],
                "inputs": {},
                "outputs": {},
                "position": { "x": 30, "y": 0 }
            }),
        ]
    }

    fn fixture_state_with(base: Map<String, Value>, entities: Vec<Value>) -> CoreState {
        CoreState::from_public_v47_parts(
            CoreCheckpointIdentity {
                slot: "normal-main".to_owned(),
                generation: 1,
                root_hash: "a".repeat(64),
                revision: 41,
                state_version: 47,
                mode: "normal".to_owned(),
                registry_fingerprint: REGISTRY.to_owned(),
                base_primary_checksum: "12345678".to_owned(),
            },
            base,
            entities
                .into_iter()
                .map(|entity| serde_json::to_string(&entity).unwrap())
                .collect(),
            Vec::new(),
            catalog(),
        )
        .unwrap()
    }

    fn fixture_state() -> CoreState {
        fixture_state_with(fixture_base(), fixture_entities())
    }

    #[allow(clippy::too_many_arguments)]
    fn projection_with_pages(
        state: &CoreState,
        requirement_cursor: usize,
        requirement_limit: usize,
        inventory_cursor: usize,
        inventory_limit: usize,
        tray_cursor: usize,
        tray_limit: usize,
        station_cursor: usize,
        station_limit: usize,
    ) -> anyhow::Result<Value> {
        state.system_space_station_workspace_projection(
            SESSION,
            RUN,
            41,
            REGISTRY,
            "helios",
            requirement_cursor,
            requirement_limit,
            inventory_cursor,
            inventory_limit,
            tray_cursor,
            tray_limit,
            station_cursor,
            station_limit,
        )
    }

    fn projection(state: &CoreState) -> Value {
        projection_with_pages(state, 0, 64, 0, 64, 0, 64, 0, 64).unwrap()
    }

    #[test]
    fn projection_is_read_only_and_covers_station_modules_modes_outputs_and_trays() {
        let state = fixture_state();
        let canonical_before = state.canonical_sha256().unwrap();
        let value = projection(&state);

        assert_eq!(
            value["projectionType"],
            SYSTEM_SPACE_STATION_WORKSPACE_SCHEMA
        );
        assert_eq!(value["sessionId"], SESSION);
        assert_eq!(value["runId"], RUN);
        assert_eq!(value["revision"], 41);
        assert_eq!(value["registryFingerprint"], REGISTRY);
        assert_eq!(value["stateVersion"], 47);
        assert_eq!(value["request"]["sessionId"], SESSION);
        assert_eq!(value["request"]["runId"], RUN);
        assert_eq!(value["system"]["systemId"], "helios");
        assert_eq!(value["system"]["displayName"], "太阳联合工程区");
        assert_eq!(value["system"]["planetCount"], 2);
        assert_eq!(value["station"]["persisted"], true);
        assert_eq!(value["station"]["status"], "building");
        assert_eq!(value["station"]["costMultiplierBasisPoints"], 9000);
        assert_eq!(value["station"]["modules"]["backbone"], 3);
        assert_eq!(value["station"]["modules"]["energy"], 2);
        assert_eq!(value["station"]["modules"]["interstellar"], 1);
        assert_eq!(value["station"]["launcherPresent"], true);
        assert_eq!(value["station"]["canStartConstruction"], false);
        assert_eq!(value["hubNetwork"]["fleetInstalled"], 20);
        assert_eq!(value["hubNetwork"]["fleetBusy"], 7);
        assert_eq!(value["hubNetwork"]["warpers"], "98765432109876543210");
        assert_eq!(value["requirements"]["totalCount"], 16);
        assert_eq!(value["requirements"]["rows"][0]["itemId"], "titanium_alloy");
        assert_eq!(value["requirements"]["rows"][0]["requiredAmount"], "900000");
        assert_eq!(
            value["requirements"]["rows"][0]["deliveredAmount"],
            "900000"
        );
        assert_eq!(value["requirements"]["rows"][0]["complete"], true);
        assert_eq!(value["sharedInventory"]["totalCount"], 2);
        assert_eq!(
            value["sharedInventory"]["rows"][0]["itemId"],
            "copper_ingot"
        );
        assert_eq!(value["sharedInventory"]["rows"][1]["itemId"], "iron_ingot");
        assert_eq!(
            value["sharedInventory"]["rows"][1]["policy"]["target"],
            "1000"
        );
        assert_eq!(value["summary"]["interstellarStationCount"], 2);
        assert_eq!(value["summary"]["mk1StationCount"], 1);
        assert_eq!(value["summary"]["mk2StationCount"], 1);
        assert_eq!(value["summary"]["elevatorStationCount"], 1);
        assert_eq!(value["summary"]["transitioningStationCount"], 0);
        let stations = value["interstellarStations"]["rows"].as_array().unwrap();
        assert_eq!(stations[0]["entityId"], "station-b");
        assert_eq!(stations[0]["operationMode"], "legacy");
        assert_eq!(stations[1]["entityId"], "station-a");
        assert_eq!(stations[1]["operationMode"], "elevator");
        assert_eq!(stations[1]["outputTargets"][0]["itemId"], "iron_ingot");
        assert_eq!(stations[1]["outputTargets"][2]["itemId"], "copper_ingot");
        assert_eq!(stations[1]["outputConfigurationEnabled"], true);
        let tray_rows = value["trayMaterials"]["rows"].as_array().unwrap();
        assert!(tray_rows.iter().any(|row| {
            row["planetId"] == "home"
                && row["itemId"] == "titanium_alloy"
                && row["amount"] == 1_000_000
                && row["constructionMaterial"] == true
        }));
        assert!(tray_rows.iter().any(|row| {
            row["planetId"] == "forge"
                && row["itemId"] == "copper_ingot"
                && row["amount"] == 4_321
                && row["constructionMaterial"] == false
        }));
        assert!(tray_rows.iter().all(|row| row["planetId"] != "away"));
        assert!(serde_json::to_vec(&value["request"]).unwrap().len() <= MAX_REQUEST_BYTES);
        assert!(serde_json::to_vec(&value).unwrap().len() <= MAX_PROJECTION_BYTES);
        let encoded = serde_json::to_string(&value).unwrap();
        for excluded in [
            "stationRoutes",
            "decorations",
            "orbitalStation",
            "contractBoard",
        ] {
            assert!(!encoded.contains(excluded));
        }
        assert_eq!(state.canonical_sha256().unwrap(), canonical_before);
    }

    #[test]
    fn four_lanes_page_independently_with_stable_order_and_exact_lineage() {
        let state = fixture_state();
        let first = projection_with_pages(&state, 0, 3, 0, 1, 0, 5, 0, 1).unwrap();
        let second = projection_with_pages(&state, 3, 3, 1, 1, 5, 5, 1, 1).unwrap();

        assert_eq!(first["requirements"]["rows"].as_array().unwrap().len(), 3);
        assert_eq!(first["requirements"]["nextCursor"], 3);
        assert_eq!(second["requirements"]["cursor"], 3);
        assert_eq!(
            second["requirements"]["rows"][0]["itemId"],
            "universe_matrix"
        );
        assert_eq!(
            first["sharedInventory"]["rows"][0]["itemId"],
            "copper_ingot"
        );
        assert_eq!(second["sharedInventory"]["rows"][0]["itemId"], "iron_ingot");
        assert_eq!(first["trayMaterials"]["nextCursor"], 5);
        assert_eq!(second["trayMaterials"]["cursor"], 5);
        assert_eq!(
            first["interstellarStations"]["rows"][0]["entityId"],
            "station-b"
        );
        assert_eq!(
            second["interstellarStations"]["rows"][0]["entityId"],
            "station-a"
        );
        assert_eq!(first["sessionId"], second["sessionId"]);
        assert_eq!(first["runId"], second["runId"]);
        assert_eq!(first["revision"], second["revision"]);
        assert_eq!(
            first,
            projection_with_pages(&state, 0, 3, 0, 1, 0, 5, 0, 1).unwrap()
        );
    }

    #[test]
    fn missing_selected_record_projects_a_read_only_default_without_migration() {
        let mut base = fixture_base();
        base["systemSpaceStations"]
            .as_object_mut()
            .unwrap()
            .remove("helios");
        let state = fixture_state_with(base, fixture_entities());
        let canonical_before = state.canonical_sha256().unwrap();
        let value = projection(&state);

        assert_eq!(value["station"]["persisted"], false);
        assert_eq!(value["station"]["status"], "not-started");
        assert_eq!(value["station"]["canStartConstruction"], true);
        assert_eq!(value["station"]["modules"]["backbone"], 0);
        assert_eq!(value["station"]["progress"]["basisPoints"], 0);
        assert_eq!(state.canonical_sha256().unwrap(), canonical_before);
    }

    #[test]
    fn request_identity_page_bounds_and_single_system_scope_fail_closed() {
        let state = fixture_state();
        let call = |session: &str,
                    run: &str,
                    revision: u64,
                    registry: &str,
                    system: &str,
                    cursor: usize,
                    limit: usize| {
            state.system_space_station_workspace_projection(
                session, run, revision, registry, system, cursor, limit, 0, 1, 0, 1, 0, 1,
            )
        };
        for result in [
            call("bad\nsession", RUN, 41, REGISTRY, "helios", 0, 1),
            call(SESSION, "bad\nrun", 41, REGISTRY, "helios", 0, 1),
            call(SESSION, RUN, 40, REGISTRY, "helios", 0, 1),
            call(SESSION, RUN, 41, "stale", "helios", 0, 1),
            call(SESSION, RUN, 41, REGISTRY, "unknown", 0, 1),
            call(SESSION, RUN, 41, REGISTRY, "helios", 0, 0),
            call(SESSION, RUN, 41, REGISTRY, "helios", 0, MAX_PAGE_ROWS + 1),
            call(SESSION, RUN, 41, REGISTRY, "helios", 17, 1),
        ] {
            assert!(result.is_err());
        }
        assert!(
            call(
                &"s".repeat(MAX_SESSION_ID_BYTES + 1),
                RUN,
                41,
                REGISTRY,
                "helios",
                0,
                1
            )
            .is_err()
        );
        assert!(
            call(
                SESSION,
                &"r".repeat(MAX_RUN_ID_BYTES + 1),
                41,
                REGISTRY,
                "helios",
                0,
                1
            )
            .is_err()
        );
    }

    #[test]
    fn mod_content_unknown_items_and_opaque_station_shapes_are_rejected() {
        let mut with_pack = fixture_base();
        with_pack["contentPacks"] = json!([{ "id": "mod:test" }]);
        assert!(
            projection_with_pages(
                &fixture_state_with(with_pack, fixture_entities()),
                0,
                1,
                0,
                1,
                0,
                1,
                0,
                1,
            )
            .is_err()
        );

        let mut unknown_tray = fixture_base();
        unknown_tray["planetTrays"]["home"]["mod:item"] = json!(1);
        assert!(
            projection_with_pages(
                &fixture_state_with(unknown_tray, fixture_entities()),
                0,
                1,
                0,
                1,
                0,
                1,
                0,
                1,
            )
            .is_err()
        );

        let mut unknown_output = fixture_entities();
        unknown_output[2]["elevatorOutputItems"][0] = json!("mod:item");
        assert!(
            projection_with_pages(
                &fixture_state_with(fixture_base(), unknown_output),
                0,
                1,
                0,
                1,
                0,
                1,
                0,
                1,
            )
            .is_err()
        );

        let mut duplicate_output = fixture_entities();
        duplicate_output[2]["elevatorOutputItems"][1] = json!("iron_ingot");
        assert!(
            projection_with_pages(
                &fixture_state_with(fixture_base(), duplicate_output),
                0,
                1,
                0,
                1,
                0,
                1,
                0,
                1,
            )
            .is_err()
        );
    }

    #[test]
    fn corrupted_decimal_mode_policy_tray_and_network_state_fail_closed() {
        let mut bad_decimal = fixture_base();
        bad_decimal["systemSpaceStations"]["helios"]["inventory"]["iron_ingot"] = json!("1e9");
        assert!(
            projection_with_pages(
                &fixture_state_with(bad_decimal, fixture_entities()),
                0,
                1,
                0,
                1,
                0,
                1,
                0,
                1,
            )
            .is_err()
        );

        let mut bad_mode = fixture_entities();
        bad_mode[2]["stationOperationMode"] = json!("opaque");
        assert!(
            projection_with_pages(
                &fixture_state_with(fixture_base(), bad_mode),
                0,
                1,
                0,
                1,
                0,
                1,
                0,
                1,
            )
            .is_err()
        );

        let mut bad_policy = fixture_base();
        bad_policy["systemSpaceStations"]["helios"]["itemPolicies"]["iron_ingot"]["opaque"] =
            json!(true);
        assert!(
            projection_with_pages(
                &fixture_state_with(bad_policy, fixture_entities()),
                0,
                1,
                0,
                1,
                0,
                1,
                0,
                1,
            )
            .is_err()
        );

        let mut bad_tray = fixture_base();
        bad_tray["planetTrays"]["home"]["iron_ingot"] = json!(1.5);
        assert!(
            projection_with_pages(
                &fixture_state_with(bad_tray, fixture_entities()),
                0,
                1,
                0,
                1,
                0,
                1,
                0,
                1,
            )
            .is_err()
        );

        let mut bad_network = fixture_base();
        bad_network["galacticHubNetwork"]["fleetBusy"] = json!(21);
        assert!(
            projection_with_pages(
                &fixture_state_with(bad_network, fixture_entities()),
                0,
                1,
                0,
                1,
                0,
                1,
                0,
                1,
            )
            .is_err()
        );
    }

    #[test]
    fn utf8_labels_are_truncated_on_scalar_boundaries_within_response_budget() {
        let mut base = fixture_base();
        base["galaxy"]["systemMetadata"]["helios"]["customName"] = Value::String("界".repeat(300));
        let value = projection(&fixture_state_with(base, fixture_entities()));
        let label = value["system"]["displayName"].as_str().unwrap();
        assert!(label.len() <= MAX_LABEL_BYTES);
        assert_eq!(label.len() % "界".len(), 0);
        assert_eq!(value["system"]["displayNameTruncated"], true);
        assert!(serde_json::to_vec(&value).unwrap().len() <= MAX_PROJECTION_BYTES);
    }
}
