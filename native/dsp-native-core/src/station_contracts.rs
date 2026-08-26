use std::collections::HashSet;

use anyhow::anyhow;
use num_bigint::BigUint;
use num_traits::{ToPrimitive, Zero};
use serde_json::{Map, Value, json};

use crate::catalog::{ItemDefinition, PlanetDefinition};
use crate::state::CoreState;

const RULES_VERSION: u64 = 1;
const HISTORY_LIMIT: usize = 48;
const SETTLEMENT_ID_LIMIT: usize = 4_096;
const MAX_INTEGER_DIGITS: usize = 256;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const TIME_ZONE_OFFSET_MS: f64 = 8.0 * 60.0 * 60.0 * 1_000.0;
const TASK_DAY_MS: f64 = 24.0 * 60.0 * 60.0 * 1_000.0;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Category {
    Industrial,
    Dyson,
    Advanced,
}

#[derive(Clone, Copy)]
struct ContractItem {
    item_id: &'static str,
    weight: u64,
    required_tech_id: Option<&'static str>,
    category: Category,
}

const CONTRACT_ITEMS: [ContractItem; 13] = [
    ContractItem {
        item_id: "titanium_alloy",
        weight: 4,
        required_tech_id: Some("titanium_alloy"),
        category: Category::Industrial,
    },
    ContractItem {
        item_id: "processor",
        weight: 3,
        required_tech_id: Some("processor"),
        category: Category::Industrial,
    },
    ContractItem {
        item_id: "particle_container",
        weight: 6,
        required_tech_id: Some("miniature_particle_collider"),
        category: Category::Industrial,
    },
    ContractItem {
        item_id: "titanium_glass",
        weight: 5,
        required_tech_id: Some("information_matrix"),
        category: Category::Industrial,
    },
    ContractItem {
        item_id: "particle_broadband",
        weight: 8,
        required_tech_id: Some("information_matrix"),
        category: Category::Industrial,
    },
    ContractItem {
        item_id: "plastic",
        weight: 2,
        required_tech_id: Some("basic_chemical_engineering"),
        category: Category::Industrial,
    },
    ContractItem {
        item_id: "space_warper",
        weight: 12,
        required_tech_id: Some("space_warp"),
        category: Category::Advanced,
    },
    ContractItem {
        item_id: "frame_material",
        weight: 10,
        required_tech_id: Some("dyson_sphere_program"),
        category: Category::Dyson,
    },
    ContractItem {
        item_id: "solar_sail",
        weight: 5,
        required_tech_id: Some("dyson_swarm"),
        category: Category::Dyson,
    },
    ContractItem {
        item_id: "small_carrier_rocket",
        weight: 45,
        required_tech_id: Some("vertical_launching_silo"),
        category: Category::Dyson,
    },
    ContractItem {
        item_id: "quantum_chip",
        weight: 14,
        required_tech_id: Some("quantum_chip"),
        category: Category::Advanced,
    },
    ContractItem {
        item_id: "antimatter_fuel_rod",
        weight: 40,
        required_tech_id: Some("artificial_star"),
        category: Category::Advanced,
    },
    ContractItem {
        item_id: "universe_matrix",
        weight: 60,
        required_tech_id: Some("universe_matrix"),
        category: Category::Advanced,
    },
];

#[derive(Clone, Copy)]
enum Difficulty {
    P1,
    P2,
    P3,
}

impl Difficulty {
    fn text(self) -> &'static str {
        match self {
            Self::P1 => "P1",
            Self::P2 => "P2",
            Self::P3 => "P3",
        }
    }

    fn units(self) -> u64 {
        match self {
            Self::P1 => 18_000,
            Self::P2 => 48_000,
            Self::P3 => 120_000,
        }
    }

    fn rewards(self) -> (u64, u64, u64, u64) {
        match self {
            Self::P1 => (45, 30, 20, 15),
            Self::P2 => (120, 80, 65, 40),
            Self::P3 => (300, 200, 180, 120),
        }
    }
}

#[derive(Clone, Copy)]
enum Template {
    Single,
    Combination,
    Dyson,
    Origin,
    MultiOrigin,
    Quantum,
    Advanced,
}

impl Template {
    fn id(self) -> &'static str {
        match self {
            Self::Single => "single",
            Self::Combination => "combination",
            Self::Dyson => "dyson",
            Self::Origin => "origin",
            Self::MultiOrigin => "multi-origin",
            Self::Quantum => "quantum",
            Self::Advanced => "advanced",
        }
    }
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

fn station_integer(value: Option<&Value>) -> BigUint {
    match value {
        Some(Value::String(text))
            if !text.is_empty()
                && text.len() <= MAX_INTEGER_DIGITS
                && text.bytes().all(|byte| byte.is_ascii_digit()) =>
        {
            BigUint::parse_bytes(text.as_bytes(), 10).unwrap_or_default()
        }
        Some(Value::Number(number)) => number
            .as_u64()
            .filter(|value| *value <= MAX_SAFE_INTEGER)
            .map(BigUint::from)
            .unwrap_or_default(),
        _ => BigUint::zero(),
    }
}

fn station_integer_text(value: BigUint) -> String {
    if value.is_zero() {
        return "0".to_owned();
    }
    let text = value.to_string();
    if text.len() <= MAX_INTEGER_DIGITS {
        text
    } else {
        "9".repeat(MAX_INTEGER_DIGITS)
    }
}

fn multiply_basis_points(value: Option<&Value>, basis_points: u64) -> BigUint {
    station_integer(value) * basis_points / 10_000_u64
}

fn hash_text(value: &str) -> u32 {
    let mut hash = 0x811c9dc5_u32;
    for unit in value.encode_utf16() {
        hash ^= u32::from(unit);
        hash = hash.wrapping_mul(0x01000193);
    }
    hash ^ (hash >> 16)
}

fn deterministic_index(seed: &str, task_day: u64, slot: usize, key: &str, length: usize) -> usize {
    if length <= 1 {
        return 0;
    }
    (hash_text(&format!("{seed}|{task_day}|{slot}|{RULES_VERSION}|{key}")) as usize) % length
}

fn rotate_pick<T: Clone>(
    values: &[T],
    count: usize,
    seed: &str,
    task_day: u64,
    slot: usize,
    key: &str,
) -> Vec<T> {
    if values.is_empty() || count == 0 {
        return Vec::new();
    }
    let wanted = count.min(values.len());
    let start = deterministic_index(seed, task_day, slot, key, values.len());
    let step = if values.len() > 1 {
        1 + deterministic_index(
            seed,
            task_day,
            slot,
            &format!("{key}:step"),
            values.len() - 1,
        )
    } else {
        1
    };
    let mut result = Vec::with_capacity(wanted);
    let mut seen = HashSet::new();
    for cursor in 0..values.len() * 2 {
        if result.len() >= wanted {
            break;
        }
        let index = (start + cursor * step) % values.len();
        if seen.insert(index) {
            result.push(values[index].clone());
        }
    }
    if result.len() < wanted {
        for (index, value) in values.iter().enumerate() {
            if result.len() >= wanted {
                break;
            }
            if seen.insert(index) {
                result.push(value.clone());
            }
        }
    }
    result
}

fn seed_text(base: &Map<String, Value>) -> String {
    base.get("galaxy")
        .and_then(Value::as_object)
        .and_then(|galaxy| galaxy.get("seed"))
        .map(|value| match value {
            Value::Number(number) => number.to_string(),
            _ => "0".to_owned(),
        })
        .unwrap_or_else(|| "0".to_owned())
}

fn completed_technologies(base: &Map<String, Value>) -> HashSet<&str> {
    base.get("research")
        .and_then(Value::as_object)
        .and_then(|research| research.get("completedTechIds"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect()
}

fn available_items(base: &Map<String, Value>) -> Vec<ContractItem> {
    let completed = completed_technologies(base);
    let produced = base.get("totalProduced").and_then(Value::as_object);
    let result = CONTRACT_ITEMS
        .iter()
        .copied()
        .filter(|candidate| {
            finite_number(produced.and_then(|values| values.get(candidate.item_id))) > 0.0
                || candidate
                    .required_tech_id
                    .is_none_or(|tech| completed.contains(tech))
        })
        .collect::<Vec<_>>();
    if !result.is_empty() {
        result
    } else {
        CONTRACT_ITEMS
            .iter()
            .copied()
            .filter(|candidate| matches!(candidate.item_id, "titanium_alloy" | "processor"))
            .collect()
    }
}

fn available_planets<'a>(
    state: &'a CoreState,
    base: &Map<String, Value>,
) -> Vec<&'a PlanetDefinition> {
    base.get("exploration")
        .and_then(Value::as_object)
        .and_then(|exploration| exploration.get("colonizedPlanetIds"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter_map(|id| state.catalog.planets.iter().find(|planet| planet.id == id))
        .filter(|planet| planet.kind != "gas-giant")
        .collect()
}

fn quantum_enabled(base: &Map<String, Value>) -> bool {
    base.get("quantumLogisticsNetwork")
        .and_then(Value::as_object)
        .and_then(|network| network.get("enabled"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn requirement(
    candidate: ContractItem,
    difficulty: Difficulty,
    channel: &str,
    source_planets: &[&PlanetDefinition],
    multiplier: f64,
) -> Value {
    let raw = difficulty.units() as f64 * multiplier / candidate.weight as f64 / 100.0;
    let amount = ((raw.floor() as u64) * 100).max(100).to_string();
    let mut value = json!({
        "itemId": candidate.item_id,
        "amount": amount,
        "delivered": "0",
        "channel": channel,
        "weight": candidate.weight,
    });
    if !source_planets.is_empty() {
        value.as_object_mut().expect("requirement object").insert(
            "sourcePlanetIds".to_owned(),
            Value::Array(
                source_planets
                    .iter()
                    .map(|planet| Value::from(planet.id.clone()))
                    .collect(),
            ),
        );
    }
    value
}

fn item_name(state: &CoreState, item: ContractItem) -> &str {
    state
        .catalog
        .items
        .get(item.item_id)
        .map(|definition: &ItemDefinition| definition.name.as_str())
        .unwrap_or(item.item_id)
}

fn create_contract(
    state: &CoreState,
    base: &Map<String, Value>,
    task_day: u64,
    slot: usize,
) -> anyhow::Result<Value> {
    let special = slot == 3;
    let seed = seed_text(base);
    let items = available_items(base);
    let planets = available_planets(state, base);
    let templates = if special {
        if quantum_enabled(base) {
            vec![Template::Advanced, Template::Quantum, Template::Dyson]
        } else {
            vec![Template::Advanced, Template::Dyson, Template::Combination]
        }
    } else {
        let mut values = vec![Template::Single, Template::Combination, Template::Dyson];
        if !planets.is_empty() {
            values.push(Template::Origin);
        }
        if planets.len() > 1 {
            values.push(Template::MultiOrigin);
        }
        if quantum_enabled(base) {
            values.push(Template::Quantum);
        }
        values
    };
    let template =
        templates[deterministic_index(&seed, task_day, slot, "template", templates.len())];
    let difficulty = if special {
        Difficulty::P3
    } else {
        match deterministic_index(&seed, task_day, slot, "difficulty", 10) {
            0..=4 => Difficulty::P1,
            5..=8 => Difficulty::P2,
            _ => Difficulty::P3,
        }
    };
    let industrial = items
        .iter()
        .copied()
        .filter(|item| item.category == Category::Industrial)
        .collect::<Vec<_>>();
    let dyson = items
        .iter()
        .copied()
        .filter(|item| item.category == Category::Dyson)
        .collect::<Vec<_>>();
    let advanced = items
        .iter()
        .copied()
        .filter(|item| item.category == Category::Advanced)
        .collect::<Vec<_>>();
    let choose = |pool: &[ContractItem], count: usize, key: &str| {
        rotate_pick(
            if pool.is_empty() { &items } else { pool },
            count,
            &seed,
            task_day,
            slot,
            key,
        )
    };
    let (requirements, title, summary) = match template {
        Template::Single => {
            let item = *choose(&items, 1, "single")
                .first()
                .ok_or_else(|| anyhow!("native contract item directory is empty"))?;
            (
                vec![requirement(item, difficulty, "any", &[], 1.0)],
                format!("{}常规出口", item_name(state, item)),
                "向轨道贸易航线提交一批标准工业物资。".to_owned(),
            )
        }
        Template::Combination => {
            let selected = choose(
                &industrial,
                if matches!(difficulty, Difficulty::P1) {
                    2
                } else {
                    3
                },
                "combination",
            );
            (
                selected
                    .into_iter()
                    .map(|item| requirement(item, difficulty, "any", &[], 0.7))
                    .collect(),
                "组合工业舱单".to_owned(),
                "按固定舱单组合交付多种工业部件。".to_owned(),
            )
        }
        Template::Dyson => {
            let selected = choose(&dyson, dyson.len().clamp(1, 2), "dyson");
            (
                selected
                    .into_iter()
                    .map(|item| requirement(item, difficulty, "any", &[], 0.8))
                    .collect(),
                "戴森工程补给".to_owned(),
                "为远端恒星工程提供结构与发射物资。".to_owned(),
            )
        }
        Template::Origin => {
            let item = *choose(&items, 1, "origin:item")
                .first()
                .ok_or_else(|| anyhow!("native contract item directory is empty"))?;
            let planet = *rotate_pick(&planets, 1, &seed, task_day, slot, "origin:planet")
                .first()
                .ok_or_else(|| anyhow!("native contract planet directory is empty"))?;
            (
                vec![requirement(item, difficulty, "terminal", &[planet], 1.0)],
                format!("{}原产订单", planet.name),
                format!(
                    "由{}的轨道货运终端提交，或由玩家确认后从量子库存交付。",
                    planet.name
                ),
            )
        }
        Template::MultiOrigin => {
            let selected_planets = rotate_pick(&planets, 2, &seed, task_day, slot, "multi:planets");
            let selected_items = choose(&items, 2, "multi:items");
            let requirements = selected_planets
                .iter()
                .enumerate()
                .map(|(index, planet)| {
                    requirement(
                        selected_items[index % selected_items.len()],
                        difficulty,
                        "terminal",
                        &[*planet],
                        0.65,
                    )
                })
                .collect();
            (
                requirements,
                "多行星协同出口".to_owned(),
                "由两颗指定行星分别完成出口配额，也可由玩家确认后从量子库存交付。".to_owned(),
            )
        }
        Template::Quantum => {
            let selected = choose(
                &advanced,
                if matches!(difficulty, Difficulty::P3) {
                    2
                } else {
                    1
                },
                "quantum",
            );
            (
                selected
                    .into_iter()
                    .map(|item| requirement(item, difficulty, "quantum", &[], 0.7))
                    .collect(),
                "量子库存应急调拨".to_owned(),
                "只能从量子共享库存手动确认交付。".to_owned(),
            )
        }
        Template::Advanced => {
            let selected = choose(&advanced, 2, "advanced");
            (
                selected
                    .into_iter()
                    .map(|item| requirement(item, Difficulty::P3, "any", &[], 0.8))
                    .collect(),
                "终局部件特别出口".to_owned(),
                "面向深空联合体的高价值特别舱单。".to_owned(),
            )
        }
    };
    let (marks, reputation, completion_marks, completion_reputation) = difficulty.rewards();
    let multiplier = if special { 2 } else { 1 };
    Ok(json!({
        "id": format!("station-contract-v{RULES_VERSION}-{seed}-{task_day}-{slot}-{}", template.id()),
        "templateId": template.id(),
        "slot": slot,
        "title": title,
        "summary": summary,
        "taskDay": task_day,
        "expiresAtTaskDay": task_day + 3,
        "special": special,
        "difficulty": difficulty.text(),
        "status": "offered",
        "requirements": requirements,
        "rewards": {
            "baseMarks": (marks * multiplier).to_string(),
            "baseReputation": (reputation * multiplier).to_string(),
            "completionMarks": (completion_marks * multiplier).to_string(),
            "completionReputation": (completion_reputation * multiplier).to_string(),
        },
    }))
}

fn completion_basis_points(contract: &Map<String, Value>) -> u64 {
    let Some(requirements) = contract.get("requirements").and_then(Value::as_array) else {
        return 10_000;
    };
    if requirements.is_empty() {
        return 10_000;
    }
    let mut weighted = BigUint::zero();
    let mut total_weight = 0_u64;
    for requirement in requirements.iter().filter_map(Value::as_object) {
        let weight = finite_number(requirement.get("weight")).floor().max(1.0) as u64;
        let amount = station_integer(requirement.get("amount"));
        let delivered = station_integer(requirement.get("delivered"));
        let basis = if amount.is_zero() {
            10_000
        } else {
            ((delivered.min(amount.clone()) * 10_000_u64) / amount)
                .to_u64()
                .unwrap_or(10_000)
                .min(10_000)
        };
        weighted += BigUint::from(basis) * weight;
        total_weight = total_weight.saturating_add(weight);
    }
    if total_weight == 0 {
        0
    } else {
        (weighted / total_weight)
            .to_u64()
            .unwrap_or(10_000)
            .min(10_000)
    }
}

fn settle_contract(
    station: &mut Map<String, Value>,
    contract: &mut Map<String, Value>,
    reason: &str,
    task_day: u64,
) -> anyhow::Result<()> {
    let id = string_at(contract, "id")
        .ok_or_else(|| anyhow!("native contract ID is missing"))?
        .to_owned();
    if contract
        .get("settlementId")
        .is_some_and(|value| !value.is_null())
    {
        return Ok(());
    }
    let already_settled = station
        .get("contractBoard")
        .and_then(Value::as_object)
        .and_then(|board| board.get("settledIds"))
        .and_then(Value::as_array)
        .is_some_and(|ids| ids.iter().any(|value| value.as_str() == Some(&id)));
    if already_settled {
        return Ok(());
    }
    let basis = completion_basis_points(contract);
    let completed = reason == "completed" && basis >= 10_000;
    let rewards = contract
        .get("rewards")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native contract rewards are missing"))?;
    let mut marks = multiply_basis_points(rewards.get("baseMarks"), basis);
    let mut reputation = multiply_basis_points(rewards.get("baseReputation"), basis);
    if completed {
        marks += station_integer(rewards.get("completionMarks"));
        reputation += station_integer(rewards.get("completionReputation"));
        let totals = station
            .get_mut("totals")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native station totals are missing"))?;
        let count = finite_number(totals.get("completedContracts"))
            .floor()
            .max(0.0) as u64;
        totals.insert(
            "completedContracts".to_owned(),
            Value::from(count.saturating_add(1).min(MAX_SAFE_INTEGER)),
        );
    }
    let economy = station
        .get_mut("economy")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native station economy is missing"))?;
    let total_marks = station_integer(economy.get("orbitalMarks")) + marks;
    let total_reputation = station_integer(economy.get("stationReputation")) + reputation;
    economy.insert(
        "orbitalMarks".to_owned(),
        Value::from(station_integer_text(total_marks)),
    );
    economy.insert(
        "stationReputation".to_owned(),
        Value::from(station_integer_text(total_reputation)),
    );
    contract.insert("status".to_owned(), Value::from("settled"));
    contract.insert(
        "settlementId".to_owned(),
        Value::from(format!("station-settlement:{id}:{reason}")),
    );
    contract.insert("settlementReason".to_owned(), Value::from(reason));
    contract.insert("settledAtTaskDay".to_owned(), Value::from(task_day));
    contract.insert("completionBasisPoints".to_owned(), Value::from(basis));
    let settled_ids = station
        .get_mut("contractBoard")
        .and_then(Value::as_object_mut)
        .and_then(|board| board.get_mut("settledIds"))
        .and_then(Value::as_array_mut)
        .ok_or_else(|| anyhow!("native contract settlement fence is missing"))?;
    settled_ids.push(Value::from(id));
    if settled_ids.len() > SETTLEMENT_ID_LIMIT {
        settled_ids.drain(0..settled_ids.len() - SETTLEMENT_ID_LIMIT);
    }
    Ok(())
}

fn expire_contracts(station: &mut Map<String, Value>, task_day: u64) -> anyhow::Result<()> {
    let accepted = {
        let accepted = station
            .get_mut("contractBoard")
            .and_then(Value::as_object_mut)
            .and_then(|board| board.get_mut("accepted"))
            .and_then(Value::as_array_mut)
            .ok_or_else(|| anyhow!("native accepted contract list is missing"))?;
        std::mem::take(accepted)
    };
    let mut remaining = Vec::with_capacity(accepted.len());
    let mut archived = Vec::new();
    for mut value in accepted {
        let contract = value
            .as_object_mut()
            .ok_or_else(|| anyhow!("native accepted contract is invalid"))?;
        let expires = finite_number(contract.get("expiresAtTaskDay"))
            .floor()
            .max(0.0) as u64;
        let settled = contract
            .get("settlementId")
            .is_some_and(|entry| !entry.is_null());
        if expires > task_day || settled {
            remaining.push(value);
            continue;
        }
        let id = string_at(contract, "id").unwrap_or_default().to_owned();
        let reason = if string_at(contract, "status") == Some("claimable") {
            "completed"
        } else {
            "expired"
        };
        settle_contract(station, contract, reason, task_day)?;
        archived.push((id, value));
    }
    *station
        .get_mut("contractBoard")
        .and_then(Value::as_object_mut)
        .and_then(|board| board.get_mut("accepted"))
        .ok_or_else(|| anyhow!("native accepted contract list disappeared"))? =
        Value::Array(remaining);
    let featured = station
        .get("contractBoard")
        .and_then(Value::as_object)
        .and_then(|board| board.get("featuredContractId"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let mut clear_featured = false;
    for (id, value) in archived {
        if featured.as_deref() == Some(&id)
            && value.get("settlementReason").and_then(Value::as_str) != Some("completed")
        {
            clear_featured = true;
        }
        let history = station
            .get_mut("contractBoard")
            .and_then(Value::as_object_mut)
            .and_then(|board| board.get_mut("history"))
            .and_then(Value::as_array_mut)
            .ok_or_else(|| anyhow!("native contract history is missing"))?;
        history.insert(0, value);
        history.truncate(HISTORY_LIMIT);
    }
    if clear_featured {
        station
            .get_mut("contractBoard")
            .and_then(Value::as_object_mut)
            .expect("validated board")
            .insert("featuredContractId".to_owned(), Value::Null);
    }
    Ok(())
}

pub(crate) fn synchronize(state: &CoreState, base: &mut Map<String, Value>) -> anyhow::Result<()> {
    let status = base
        .get("orbitalStation")
        .and_then(Value::as_object)
        .and_then(|station| string_at(station, "status"))
        .unwrap_or("locked");
    if !matches!(status, "showcase-building" | "operational") {
        return Ok(());
    }
    let (task_day, last_confirmed, offers_empty) = {
        let board = base
            .get("orbitalStation")
            .and_then(Value::as_object)
            .and_then(|station| station.get("contractBoard"))
            .and_then(Value::as_object)
            .ok_or_else(|| anyhow!("native station contract board is missing"))?;
        (
            finite_number(board.get("taskDay")).floor().max(0.0) as u64,
            finite_number(board.get("lastConfirmedWallClockMs"))
                .floor()
                .max(0.0),
            board
                .get("offers")
                .and_then(Value::as_array)
                .is_none_or(Vec::is_empty),
        )
    };
    let local_day = ((last_confirmed + TIME_ZONE_OFFSET_MS) / TASK_DAY_MS)
        .floor()
        .max(0.0) as u64;
    let next_day = task_day.max(local_day);
    if next_day == task_day && !offers_empty {
        return Ok(());
    }
    let generated = if offers_empty || next_day > task_day {
        (0..4)
            .map(|slot| create_contract(state, base, next_day, slot))
            .collect::<anyhow::Result<Vec<_>>>()?
    } else {
        Vec::new()
    };
    let station = base
        .get_mut("orbitalStation")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native orbital station is missing"))?;
    if next_day > task_day {
        station
            .get_mut("contractBoard")
            .and_then(Value::as_object_mut)
            .expect("validated board")
            .insert("taskDay".to_owned(), Value::from(next_day));
        expire_contracts(station, next_day)?;
        station
            .get_mut("contractBoard")
            .and_then(Value::as_object_mut)
            .expect("validated board")
            .insert("offers".to_owned(), Value::Array(Vec::new()));
    }
    let board = station
        .get_mut("contractBoard")
        .and_then(Value::as_object_mut)
        .expect("validated board");
    board.insert(
        "lastConfirmedWallClockMs".to_owned(),
        Value::from(last_confirmed as u64),
    );
    let needs_offers = board
        .get("offers")
        .and_then(Value::as_array)
        .is_none_or(Vec::is_empty);
    if needs_offers {
        let unavailable = board
            .get("settledIds")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .chain(
                board
                    .get("history")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|value| value.get("id")),
            )
            .chain(
                board
                    .get("accepted")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|value| value.get("id")),
            )
            .filter_map(Value::as_str)
            .collect::<HashSet<_>>();
        board.insert(
            "offers".to_owned(),
            Value::Array(
                generated
                    .into_iter()
                    .filter(|contract| {
                        contract
                            .get("id")
                            .and_then(Value::as_str)
                            .is_some_and(|id| !unavailable.contains(id))
                    })
                    .collect(),
            ),
        );
    }
    Ok(())
}
