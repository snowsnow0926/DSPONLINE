use std::collections::{BTreeMap, BTreeSet};

use anyhow::{anyhow, bail};
use num_bigint::BigUint;
use num_traits::{ToPrimitive, Zero};
use serde_json::{Map, Number, Value};

use crate::deterministic_runtime::{DeterministicRuntime, runtime as deterministic_runtime};
use crate::state::CoreState;

const PORT_COUNT: usize = 4;
const UPLOAD_PER_MINUTE: f64 = 20_000.0;
const MAX_INTEGER_DIGITS: usize = 256;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const CONTRACT_RULES_VERSION: u64 = 1;
const MAX_ACCEPTED_CONTRACTS: usize = 3;
const MAX_CONTRACT_REQUIREMENTS: usize = 6;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PureIdleContractStatus {
    Accepted,
    Claimable,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PureIdleContractRewards {
    pub(crate) base_marks: BigUint,
    pub(crate) base_reputation: BigUint,
    pub(crate) completion_marks: BigUint,
    pub(crate) completion_reputation: BigUint,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PureIdleContractRequirementConfig {
    pub(crate) item_id: String,
    pub(crate) amount: BigUint,
    pub(crate) channel: String,
    pub(crate) source_planet_ids: Option<Vec<String>>,
    pub(crate) weight: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PureIdleContractRequirementEndpoint {
    pub(crate) config: PureIdleContractRequirementConfig,
    pub(crate) delivered: BigUint,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PureIdleContractConfig {
    pub(crate) id: String,
    pub(crate) template_id: String,
    pub(crate) slot: u64,
    pub(crate) task_day: u64,
    pub(crate) expires_at_task_day: u64,
    pub(crate) special: bool,
    pub(crate) difficulty: String,
    pub(crate) rewards: PureIdleContractRewards,
    pub(crate) requirements: Vec<PureIdleContractRequirementConfig>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PureIdleContractEndpointRow {
    pub(crate) config: PureIdleContractConfig,
    pub(crate) status: PureIdleContractStatus,
    pub(crate) accepted_at_task_day: Option<u64>,
    pub(crate) requirements: Vec<PureIdleContractRequirementEndpoint>,
}

/// The immutable/configuration half of an endpoint. Adjacent exact windows
/// may compare this compact value before inspecting progress deltas. Status is
/// deliberately included: becoming claimable changes terminal reachability
/// even though claiming the reward remains a manual command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PureIdleContractConfigSnapshot {
    pub(crate) station_status: String,
    pub(crate) rules_version: u64,
    pub(crate) task_day: u64,
    pub(crate) last_confirmed_wall_clock_ms: u64,
    pub(crate) accepted: Vec<(PureIdleContractConfig, PureIdleContractStatus, Option<u64>)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PureIdleContractBoundaryRequirement {
    pub(crate) requirement_index: usize,
    pub(crate) item_id: String,
    pub(crate) remaining: BigUint,
}

/// Remaining material distance to one accepted row becoming claimable. The
/// ordered requirement vector is retained because a scalar total alone cannot
/// prove which material closes a multi-item contract.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PureIdleContractClaimableBoundary {
    pub(crate) contract_index: usize,
    pub(crate) contract_id: String,
    pub(crate) remaining_total: BigUint,
    pub(crate) remaining_by_item: BTreeMap<String, BigUint>,
    pub(crate) remaining_requirements: Vec<PureIdleContractBoundaryRequirement>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PureIdleContractEndpoint {
    pub(crate) station_status: String,
    pub(crate) rules_version: u64,
    pub(crate) task_day: u64,
    pub(crate) last_confirmed_wall_clock_ms: u64,
    /// Persisted accepted-array order. No ID sort is permitted.
    pub(crate) accepted: Vec<PureIdleContractEndpointRow>,
    pub(crate) exported_by_item: BTreeMap<String, BigUint>,
    pub(crate) first_claimable_boundary: Option<PureIdleContractClaimableBoundary>,
}

impl PureIdleContractEndpoint {
    pub(crate) fn config_snapshot(&self) -> PureIdleContractConfigSnapshot {
        PureIdleContractConfigSnapshot {
            station_status: self.station_status.clone(),
            rules_version: self.rules_version,
            task_day: self.task_day,
            last_confirmed_wall_clock_ms: self.last_confirmed_wall_clock_ms,
            accepted: self
                .accepted
                .iter()
                .map(|contract| {
                    (
                        contract.config.clone(),
                        contract.status,
                        contract.accepted_at_task_day,
                    )
                })
                .collect(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PureIdleContractDeliveryStep {
    pub(crate) contract_index: usize,
    pub(crate) contract_id: String,
    pub(crate) requirement_index: usize,
    pub(crate) item_id: String,
    pub(crate) expected_delivered: BigUint,
    pub(crate) amount: BigUint,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PureIdleContractDeliveryBoundary {
    pub(crate) contract_index: usize,
    pub(crate) contract_id: String,
    pub(crate) requirement_index: usize,
    pub(crate) item_id: String,
    /// The one unit deliberately retained so status stays `accepted`.
    pub(crate) reserved_units: BigUint,
    pub(crate) distance_before_plan: PureIdleContractClaimableBoundary,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PureIdleContractDeliveryPlan {
    pub(crate) expected_endpoint: PureIdleContractEndpoint,
    pub(crate) production_budget_by_item: BTreeMap<String, BigUint>,
    /// `Some` binds a calibrated terminal schedule to exact persisted rows.
    /// `None` is the aggregate convenience planner used only when no external
    /// target schedule exists.
    pub(crate) requested_steps: Option<Vec<PureIdleContractDeliveryStep>>,
    pub(crate) steps: Vec<PureIdleContractDeliveryStep>,
    pub(crate) planned_consumed_by_item: BTreeMap<String, BigUint>,
    pub(crate) unused_budget_by_item: BTreeMap<String, BigUint>,
    pub(crate) export_limited_by_item: BTreeMap<String, BigUint>,
    pub(crate) boundary_limited: bool,
    pub(crate) boundary: Option<PureIdleContractDeliveryBoundary>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PureIdleContractDeliveryReceipt {
    pub(crate) consumed_by_item: BTreeMap<String, BigUint>,
    pub(crate) unused_budget_by_item: BTreeMap<String, BigUint>,
    pub(crate) export_limited_by_item: BTreeMap<String, BigUint>,
    pub(crate) boundary_limited: bool,
    pub(crate) boundary: Option<PureIdleContractDeliveryBoundary>,
    pub(crate) endpoint_before: PureIdleContractEndpoint,
    pub(crate) endpoint_after: PureIdleContractEndpoint,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PureIdleContractRequirementDelta {
    pub(crate) contract_index: usize,
    pub(crate) contract_id: String,
    pub(crate) requirement_index: usize,
    pub(crate) item_id: String,
    pub(crate) delivered: BigUint,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PureIdleContractIntervalReceipt {
    /// Includes zero rows in persisted contract/requirement order so three
    /// adjacent windows can compare rates without losing a dormant endpoint.
    pub(crate) requirement_deltas: Vec<PureIdleContractRequirementDelta>,
    pub(crate) consumed_by_item: BTreeMap<String, BigUint>,
    pub(crate) claimable_contract_ids: Vec<String>,
}

#[derive(Debug)]
struct CargoInput {
    item_id: String,
    port_index: usize,
    available: BigUint,
    planned: BigUint,
}

#[derive(Debug)]
struct CargoRequestProbe {
    item_id: String,
    port_index: usize,
    buffered_amount: u64,
}

#[derive(Debug)]
struct ActiveTerminalProbe {
    entity_index: usize,
    entity_id: Option<String>,
    binding: Value,
    planet_id: String,
    power_factor: f64,
    progress: f64,
    routing_cursor: usize,
    requests: Vec<CargoRequestProbe>,
}

#[derive(Debug)]
struct TerminalProbe {
    entity_index: usize,
    reconcile_binding: bool,
    active: Option<ActiveTerminalProbe>,
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

fn set_number(object: &mut Map<String, Value>, key: &str, value: f64) -> anyhow::Result<()> {
    let number = Number::from_f64(value)
        .ok_or_else(|| anyhow!("native orbital cargo simulation produced a non-finite number"))?;
    object.insert(key.to_owned(), Value::Number(number));
    Ok(())
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

fn maximum_station_integer() -> BigUint {
    BigUint::from(10_u8).pow(MAX_INTEGER_DIGITS as u32) - 1_u8
}

fn strict_contract_integer(value: Option<&Value>, label: &str) -> anyhow::Result<BigUint> {
    match value {
        Some(Value::String(text))
            if !text.is_empty()
                && text.len() <= MAX_INTEGER_DIGITS
                && text.bytes().all(|byte| byte.is_ascii_digit()) =>
        {
            BigUint::parse_bytes(text.as_bytes(), 10)
                .ok_or_else(|| anyhow!("{label} is not a decimal integer"))
        }
        Some(Value::Number(number)) => number
            .as_u64()
            .filter(|value| *value <= MAX_SAFE_INTEGER)
            .map(BigUint::from)
            .ok_or_else(|| anyhow!("{label} is not a safe non-negative integer")),
        _ => bail!("{label} is missing or not a non-negative integer"),
    }
}

fn strict_contract_u64(value: Option<&Value>, label: &str) -> anyhow::Result<u64> {
    value
        .and_then(Value::as_u64)
        .filter(|value| *value <= MAX_SAFE_INTEGER)
        .ok_or_else(|| anyhow!("{label} is missing or not a safe non-negative integer"))
}

fn strict_contract_text<'a>(
    object: &'a Map<String, Value>,
    key: &str,
    label: &str,
) -> anyhow::Result<&'a str> {
    let value = string_at(object, key)
        .filter(|value| !value.is_empty() && value.len() <= 512)
        .ok_or_else(|| anyhow!("{label} is missing or invalid"))?;
    Ok(value)
}

fn reject_unknown_contract_keys(
    object: &Map<String, Value>,
    allowed: &[&str],
    label: &str,
) -> anyhow::Result<()> {
    if let Some(key) = object.keys().find(|key| !allowed.contains(&key.as_str())) {
        bail!("{label} contains unsupported field {key}")
    }
    Ok(())
}

fn expected_pure_idle_contract_rewards(
    difficulty: &str,
    special: bool,
) -> anyhow::Result<PureIdleContractRewards> {
    let (base_marks, base_reputation, completion_marks, completion_reputation) = match difficulty {
        "P1" => (45_u64, 30_u64, 20_u64, 15_u64),
        "P2" => (120, 80, 65, 40),
        "P3" => (300, 200, 180, 120),
        _ => bail!("native pure-idle contract difficulty is unsupported"),
    };
    let multiplier = if special { 2_u64 } else { 1_u64 };
    Ok(PureIdleContractRewards {
        base_marks: BigUint::from(base_marks * multiplier),
        base_reputation: BigUint::from(base_reputation * multiplier),
        completion_marks: BigUint::from(completion_marks * multiplier),
        completion_reputation: BigUint::from(completion_reputation * multiplier),
    })
}

fn contract_boundary(
    contract_index: usize,
    contract: &PureIdleContractEndpointRow,
) -> PureIdleContractClaimableBoundary {
    let mut remaining_total = BigUint::zero();
    let mut remaining_by_item = BTreeMap::<String, BigUint>::new();
    let mut remaining_requirements = Vec::new();
    for (requirement_index, requirement) in contract.requirements.iter().enumerate() {
        let remaining = positive_difference(
            requirement.config.amount.clone(),
            requirement.delivered.clone(),
        );
        if remaining.is_zero() {
            continue;
        }
        remaining_total += &remaining;
        *remaining_by_item
            .entry(requirement.config.item_id.clone())
            .or_default() += &remaining;
        remaining_requirements.push(PureIdleContractBoundaryRequirement {
            requirement_index,
            item_id: requirement.config.item_id.clone(),
            remaining,
        });
    }
    PureIdleContractClaimableBoundary {
        contract_index,
        contract_id: contract.config.id.clone(),
        remaining_total,
        remaining_by_item,
        remaining_requirements,
    }
}

fn capture_pure_idle_contract_endpoint_from_station(
    state: &CoreState,
    base: &Map<String, Value>,
    station: &Map<String, Value>,
) -> anyhow::Result<PureIdleContractEndpoint> {
    if base.get("mode").and_then(Value::as_str) != Some("normal") {
        bail!("native pure-idle contract delivery requires normal mode")
    }
    let station_status = strict_contract_text(station, "status", "station status")?;
    if !matches!(station_status, "showcase-building" | "operational") {
        bail!("native pure-idle contract board is not unlocked")
    }
    let board = station
        .get("contractBoard")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native pure-idle contract board is invalid"))?;
    let rules_version = strict_contract_u64(board.get("rulesVersion"), "contract rules version")?;
    if rules_version != CONTRACT_RULES_VERSION {
        bail!("native pure-idle contract rules version is unsupported")
    }
    let task_day = strict_contract_u64(board.get("taskDay"), "contract task day")?;
    let last_confirmed_wall_clock_ms = strict_contract_u64(
        board.get("lastConfirmedWallClockMs"),
        "contract confirmed wall clock",
    )?;
    let accepted_values = board
        .get("accepted")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("native pure-idle accepted contract list is invalid"))?;
    if accepted_values.len() > MAX_ACCEPTED_CONTRACTS {
        bail!("native pure-idle accepted contract list exceeds its bound")
    }
    let galaxy_seed = base
        .get("galaxy")
        .and_then(Value::as_object)
        .and_then(|galaxy| galaxy.get("seed"))
        .and_then(Value::as_i64)
        .ok_or_else(|| anyhow!("native pure-idle contract galaxy seed is invalid"))?;
    let mut accepted_ids = BTreeSet::new();
    let mut accepted = Vec::with_capacity(accepted_values.len());
    for value in accepted_values {
        let contract = value
            .as_object()
            .ok_or_else(|| anyhow!("native pure-idle accepted contract row is invalid"))?;
        reject_unknown_contract_keys(
            contract,
            &[
                "id",
                "templateId",
                "slot",
                "title",
                "summary",
                "taskDay",
                "expiresAtTaskDay",
                "special",
                "difficulty",
                "status",
                "requirements",
                "rewards",
                "acceptedAtTaskDay",
                "settlementId",
                "settlementReason",
                "settledAtTaskDay",
                "completionBasisPoints",
            ],
            "native pure-idle accepted contract",
        )?;
        for field in [
            "settlementId",
            "settlementReason",
            "settledAtTaskDay",
            "completionBasisPoints",
        ] {
            if contract.get(field).is_some_and(|value| !value.is_null()) {
                bail!("native pure-idle accepted contract is already settled")
            }
        }
        let id = strict_contract_text(contract, "id", "accepted contract ID")?.to_owned();
        if !accepted_ids.insert(id.clone()) {
            bail!("native pure-idle accepted contract ID is duplicated")
        }
        let template_id =
            strict_contract_text(contract, "templateId", "accepted contract template")?.to_owned();
        if !matches!(
            template_id.as_str(),
            "single" | "combination" | "dyson" | "origin" | "multi-origin" | "quantum" | "advanced"
        ) {
            bail!("native pure-idle accepted contract template is unsupported")
        }
        strict_contract_text(contract, "title", "accepted contract title")?;
        strict_contract_text(contract, "summary", "accepted contract summary")?;
        let slot = strict_contract_u64(contract.get("slot"), "accepted contract slot")?;
        let contract_task_day =
            strict_contract_u64(contract.get("taskDay"), "accepted contract task day")?;
        let expires_at_task_day =
            strict_contract_u64(contract.get("expiresAtTaskDay"), "accepted contract expiry")?;
        let special = contract
            .get("special")
            .and_then(Value::as_bool)
            .ok_or_else(|| anyhow!("native pure-idle accepted contract special flag is invalid"))?;
        if slot > 3
            || special != (slot == 3)
            || expires_at_task_day != contract_task_day.saturating_add(3)
            || contract_task_day > task_day
            || expires_at_task_day <= task_day
        {
            bail!("native pure-idle accepted contract day/slot identity is invalid")
        }
        let expected_id = format!(
            "station-contract-v{CONTRACT_RULES_VERSION}-{galaxy_seed}-{contract_task_day}-{slot}-{template_id}"
        );
        if id != expected_id {
            bail!("native pure-idle accepted contract deterministic ID is invalid")
        }
        let difficulty =
            strict_contract_text(contract, "difficulty", "accepted contract difficulty")?
                .to_owned();
        let expected_rewards = expected_pure_idle_contract_rewards(&difficulty, special)?;
        let rewards = contract
            .get("rewards")
            .and_then(Value::as_object)
            .ok_or_else(|| anyhow!("native pure-idle accepted contract rewards are invalid"))?;
        reject_unknown_contract_keys(
            rewards,
            &[
                "baseMarks",
                "baseReputation",
                "completionMarks",
                "completionReputation",
            ],
            "native pure-idle accepted contract rewards",
        )?;
        let observed_rewards = PureIdleContractRewards {
            base_marks: strict_contract_integer(rewards.get("baseMarks"), "contract base marks")?,
            base_reputation: strict_contract_integer(
                rewards.get("baseReputation"),
                "contract base reputation",
            )?,
            completion_marks: strict_contract_integer(
                rewards.get("completionMarks"),
                "contract completion marks",
            )?,
            completion_reputation: strict_contract_integer(
                rewards.get("completionReputation"),
                "contract completion reputation",
            )?,
        };
        if observed_rewards != expected_rewards {
            bail!("native pure-idle accepted contract rewards are not deterministic")
        }
        let status = match strict_contract_text(contract, "status", "accepted contract status")? {
            "accepted" => PureIdleContractStatus::Accepted,
            "claimable" => PureIdleContractStatus::Claimable,
            _ => bail!("native pure-idle accepted contract status is unsupported"),
        };
        let accepted_at_task_day = match contract.get("acceptedAtTaskDay") {
            None | Some(Value::Null) => None,
            value => Some(strict_contract_u64(
                value,
                "accepted contract acceptance day",
            )?),
        };
        if accepted_at_task_day.is_some_and(|accepted_day| accepted_day > task_day) {
            bail!("native pure-idle accepted contract acceptance day is in the future")
        }
        let requirement_values = contract
            .get("requirements")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                anyhow!("native pure-idle accepted contract requirements are invalid")
            })?;
        if requirement_values.is_empty() || requirement_values.len() > MAX_CONTRACT_REQUIREMENTS {
            bail!("native pure-idle accepted contract requirement count is invalid")
        }
        let mut requirements = Vec::with_capacity(requirement_values.len());
        for value in requirement_values {
            let requirement = value
                .as_object()
                .ok_or_else(|| anyhow!("native pure-idle contract requirement is invalid"))?;
            reject_unknown_contract_keys(
                requirement,
                &[
                    "itemId",
                    "amount",
                    "delivered",
                    "channel",
                    "sourcePlanetIds",
                    "weight",
                ],
                "native pure-idle contract requirement",
            )?;
            let item_id = strict_contract_text(requirement, "itemId", "contract requirement item")?
                .to_owned();
            if !state.catalog.items.contains_key(&item_id) {
                bail!("native pure-idle contract requirement item is unknown")
            }
            let amount =
                strict_contract_integer(requirement.get("amount"), "contract requirement amount")?;
            let delivered = strict_contract_integer(
                requirement.get("delivered"),
                "contract requirement delivered",
            )?;
            if amount.is_zero() || delivered > amount {
                bail!("native pure-idle contract requirement progress is invalid")
            }
            let channel =
                strict_contract_text(requirement, "channel", "contract requirement channel")?
                    .to_owned();
            if !matches!(channel.as_str(), "any" | "terminal" | "quantum") {
                bail!("native pure-idle contract requirement channel is unsupported")
            }
            let weight =
                strict_contract_u64(requirement.get("weight"), "contract requirement weight")?;
            if !(1..=10_000).contains(&weight) {
                bail!("native pure-idle contract requirement weight is invalid")
            }
            let source_planet_ids = match requirement.get("sourcePlanetIds") {
                None => None,
                Some(source) => {
                    let source = source.as_array().ok_or_else(|| {
                        anyhow!("native pure-idle contract source planets are invalid")
                    })?;
                    if source.len() > 4 {
                        bail!("native pure-idle contract source planets exceed their bound")
                    }
                    let mut seen = BTreeSet::new();
                    let mut planets = Vec::with_capacity(source.len());
                    for value in source {
                        let planet_id = value.as_str().ok_or_else(|| {
                            anyhow!("native pure-idle contract source planet is invalid")
                        })?;
                        if !seen.insert(planet_id.to_owned())
                            || !state
                                .catalog
                                .planets
                                .iter()
                                .any(|planet| planet.id == planet_id)
                        {
                            bail!("native pure-idle contract source planet is invalid")
                        }
                        planets.push(planet_id.to_owned());
                    }
                    Some(planets)
                }
            };
            requirements.push(PureIdleContractRequirementEndpoint {
                config: PureIdleContractRequirementConfig {
                    item_id,
                    amount,
                    channel,
                    source_planet_ids,
                    weight,
                },
                delivered,
            });
        }
        let complete = requirements
            .iter()
            .all(|requirement| requirement.delivered == requirement.config.amount);
        if (status == PureIdleContractStatus::Claimable) != complete {
            bail!("native pure-idle contract claimable status is inconsistent")
        }
        let config_requirements = requirements
            .iter()
            .map(|requirement| requirement.config.clone())
            .collect();
        accepted.push(PureIdleContractEndpointRow {
            config: PureIdleContractConfig {
                id,
                template_id,
                slot,
                task_day: contract_task_day,
                expires_at_task_day,
                special,
                difficulty,
                rewards: expected_rewards,
                requirements: config_requirements,
            },
            status,
            accepted_at_task_day,
            requirements,
        });
    }
    let exported = station
        .get("totals")
        .and_then(Value::as_object)
        .and_then(|totals| totals.get("exportedByItem"))
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native pure-idle contract export totals are invalid"))?;
    let mut exported_by_item = BTreeMap::new();
    for (item_id, amount) in exported {
        if !state.catalog.items.contains_key(item_id) {
            bail!("native pure-idle contract export total item is unknown")
        }
        let amount = strict_contract_integer(Some(amount), "contract export total")?;
        if !amount.is_zero() {
            exported_by_item.insert(item_id.clone(), amount);
        }
    }
    let first_claimable_boundary = accepted
        .iter()
        .enumerate()
        .find(|(_, contract)| contract.status == PureIdleContractStatus::Accepted)
        .map(|(contract_index, contract)| contract_boundary(contract_index, contract));
    Ok(PureIdleContractEndpoint {
        station_status: station_status.to_owned(),
        rules_version,
        task_day,
        last_confirmed_wall_clock_ms,
        accepted,
        exported_by_item,
        first_claimable_boundary,
    })
}

/// Capture the complete compact contract endpoint without reading any tray,
/// quantum inventory, entity input, terminal progress, or routing cursor.
pub(crate) fn capture_pure_idle_contract_endpoint(
    state: &CoreState,
) -> anyhow::Result<PureIdleContractEndpoint> {
    let base = state.base_value();
    let station = station_object(base)
        .ok_or_else(|| anyhow!("native pure-idle orbital station state is missing"))?;
    capture_pure_idle_contract_endpoint_from_station(state, base, station)
}

fn positive_difference(required: BigUint, delivered: BigUint) -> BigUint {
    if required > delivered {
        required - delivered
    } else {
        BigUint::zero()
    }
}

fn active_stage_id(status: &str) -> Option<&'static str> {
    match status {
        "eligible" | "core-building" => Some("core"),
        "dock-building" => Some("dock"),
        "showcase-building" => Some("showcase"),
        _ => None,
    }
}

fn station_object(base: &Map<String, Value>) -> Option<&Map<String, Value>> {
    base.get("orbitalStation").and_then(Value::as_object)
}

fn station_status(base: &Map<String, Value>) -> &str {
    station_object(base)
        .and_then(|station| string_at(station, "status"))
        .unwrap_or("locked")
}

fn construction_remaining(base: &Map<String, Value>, item_id: &str) -> BigUint {
    let Some(station) = station_object(base) else {
        return BigUint::zero();
    };
    let Some(stage_id) = string_at(station, "status").and_then(active_stage_id) else {
        return BigUint::zero();
    };
    let Some(stage) = station
        .get("construction")
        .and_then(Value::as_object)
        .and_then(|construction| construction.get("stageRequirements"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .find(|stage| string_at(stage, "stageId") == Some(stage_id))
    else {
        return BigUint::zero();
    };
    let delivered = stage.get("delivered").and_then(Value::as_object);
    stage
        .get("costs")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .filter(|cost| string_at(cost, "itemId") == Some(item_id))
        .fold(BigUint::zero(), |total, cost| {
            let required = station_integer(cost.get("amount"));
            let current = station_integer(delivered.and_then(|values| values.get(item_id)));
            total + positive_difference(required, current)
        })
}

fn source_planet_allowed(requirement: &Map<String, Value>, planet_id: &str) -> bool {
    if string_at(requirement, "channel") == Some("quantum") {
        return false;
    }
    requirement
        .get("sourcePlanetIds")
        .and_then(Value::as_array)
        .is_none_or(|planets| {
            planets.is_empty()
                || planets
                    .iter()
                    .any(|value| value.as_str() == Some(planet_id))
        })
}

fn accepted_contract<'a>(
    station: &'a Map<String, Value>,
    contract_id: &str,
) -> Option<&'a Map<String, Value>> {
    station
        .get("contractBoard")
        .and_then(Value::as_object)
        .and_then(|board| board.get("accepted"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .find(|contract| string_at(contract, "id") == Some(contract_id))
}

fn contract_remaining(
    base: &Map<String, Value>,
    contract_id: &str,
    item_id: &str,
    planet_id: &str,
) -> BigUint {
    let Some(contract) =
        station_object(base).and_then(|station| accepted_contract(station, contract_id))
    else {
        return BigUint::zero();
    };
    contract
        .get("requirements")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .filter(|requirement| {
            string_at(requirement, "itemId") == Some(item_id)
                && source_planet_allowed(requirement, planet_id)
        })
        .fold(BigUint::zero(), |total, requirement| {
            let required = station_integer(requirement.get("amount"));
            let delivered = station_integer(requirement.get("delivered"));
            total + positive_difference(required, delivered)
        })
}

fn binding_contract_id(binding: &Value) -> Option<&str> {
    let binding = binding.as_object()?;
    (string_at(binding, "kind") == Some("contract"))
        .then(|| string_at(binding, "contractId"))
        .flatten()
}

fn binding_is_construction(binding: &Value) -> bool {
    binding
        .as_object()
        .and_then(|binding| string_at(binding, "kind"))
        == Some("construction")
}

fn binding_is_valid(base: &Map<String, Value>, binding: Option<&Value>) -> bool {
    let Some(binding) = binding.filter(|binding| !binding.is_null()) else {
        return true;
    };
    if binding_is_construction(binding) {
        return matches!(
            station_status(base),
            "eligible" | "core-building" | "dock-building" | "showcase-building"
        );
    }
    let Some(contract_id) = binding_contract_id(binding) else {
        return false;
    };
    station_object(base)
        .and_then(|station| accepted_contract(station, contract_id))
        .and_then(|contract| string_at(contract, "status"))
        .is_some_and(|status| matches!(status, "accepted" | "claimable"))
}

fn target_remaining(
    base: &Map<String, Value>,
    binding: Option<&Value>,
    item_id: &str,
    planet_id: &str,
) -> BigUint {
    let Some(binding) = binding.filter(|binding| !binding.is_null()) else {
        return BigUint::zero();
    };
    if binding_is_construction(binding) {
        construction_remaining(base, item_id)
    } else if let Some(contract_id) = binding_contract_id(binding) {
        contract_remaining(base, contract_id, item_id, planet_id)
    } else {
        BigUint::zero()
    }
}

fn port_items(state: &CoreState, terminal: &Map<String, Value>) -> [Option<String>; PORT_COUNT] {
    std::array::from_fn(|index| {
        terminal
            .get("orbitalCargoPortItems")
            .and_then(Value::as_array)
            .and_then(|items| items.get(index))
            .and_then(Value::as_str)
            .filter(|item_id| state.catalog.items.contains_key(*item_id))
            .map(str::to_owned)
    })
}

pub(crate) fn terminal_accepts(
    state: &CoreState,
    terminal: &Map<String, Value>,
    item_id: &str,
    requested_port: Option<u8>,
) -> bool {
    let base = state.base_value();
    if base.get("mode").and_then(Value::as_str) != Some("normal")
        || string_at(terminal, "buildingId") != Some("orbital_cargo_terminal")
        || !state.catalog.items.contains_key(item_id)
    {
        return false;
    }
    let planet_id = string_at(terminal, "planetId").unwrap_or_default();
    let colonized = base
        .get("exploration")
        .and_then(Value::as_object)
        .and_then(|exploration| exploration.get("colonizedPlanetIds"))
        .and_then(Value::as_array)
        .is_some_and(|planets| {
            planets
                .iter()
                .any(|planet| planet.as_str() == Some(planet_id))
        });
    if !colonized
        || target_remaining(
            base,
            terminal.get("orbitalCargoBinding"),
            item_id,
            planet_id,
        )
        .is_zero()
    {
        return false;
    }
    let ports = port_items(state, terminal);
    if let Some(port) = requested_port.map(usize::from) {
        return port < PORT_COUNT
            && ports[port]
                .as_deref()
                .is_none_or(|configured| configured == item_id);
    }
    ports.iter().any(|configured| {
        configured
            .as_deref()
            .is_none_or(|configured| configured == item_id)
    })
}

pub(crate) fn admission_reason(state: &CoreState) -> anyhow::Result<Option<&'static str>> {
    let base = state.base_value();
    for &index in &state.factory_topology.orbital_cargo_terminal_indices {
        let terminal = state.parse_entity(index)?;
        let terminal = terminal
            .as_object()
            .ok_or_else(|| anyhow!("native orbital cargo terminal is not an object"))?;
        if string_at(terminal, "kind") != Some("storage")
            || terminal.get("inputs").and_then(Value::as_object).is_none()
            || terminal.get("outputs").and_then(Value::as_object).is_none()
        {
            return Ok(Some("orbital-cargo-terminal-record-invalid"));
        }
        let binding = terminal.get("orbitalCargoBinding");
        if !binding_is_valid(base, binding) || binding.is_none_or(Value::is_null) {
            continue;
        }
    }
    Ok(None)
}

fn stage_is_complete(stage: &Map<String, Value>) -> bool {
    let delivered = stage.get("delivered").and_then(Value::as_object);
    let costs_complete = stage
        .get("costs")
        .and_then(Value::as_array)
        .is_some_and(|costs| {
            costs.iter().filter_map(Value::as_object).all(|cost| {
                let Some(item_id) = string_at(cost, "itemId") else {
                    return false;
                };
                station_integer(delivered.and_then(|values| values.get(item_id)))
                    >= station_integer(cost.get("amount"))
            })
        });
    let fleet_complete = stage
        .get("fleetCosts")
        .and_then(Value::as_object)
        .is_none_or(|costs| {
            let delivered = stage.get("deliveredFleet").and_then(Value::as_object);
            costs.iter().all(|(fleet_id, amount)| {
                finite_number(delivered.and_then(|values| values.get(fleet_id)))
                    .floor()
                    .max(0.0)
                    >= finite_number(Some(amount)).floor().max(0.0)
            })
        });
    costs_complete && fleet_complete
}

fn deliver_construction(
    base: &mut Map<String, Value>,
    item_id: &str,
    amount: &BigUint,
) -> anyhow::Result<BigUint> {
    if amount.is_zero() {
        return Ok(BigUint::zero());
    }
    let station = base
        .get_mut("orbitalStation")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native orbital station state is missing"))?;
    let status = string_at(station, "status").unwrap_or("locked").to_owned();
    let Some(stage_id) = active_stage_id(&status) else {
        return Ok(BigUint::zero());
    };
    if status == "eligible" {
        station.insert("status".to_owned(), Value::from("core-building"));
    }
    let stages = station
        .get_mut("construction")
        .and_then(Value::as_object_mut)
        .and_then(|construction| construction.get_mut("stageRequirements"))
        .and_then(Value::as_array_mut)
        .ok_or_else(|| anyhow!("native orbital construction stages are missing"))?;
    let Some(stage_index) = stages.iter().position(|stage| {
        stage
            .as_object()
            .and_then(|stage| string_at(stage, "stageId"))
            == Some(stage_id)
    }) else {
        return Ok(BigUint::zero());
    };
    let stage = stages[stage_index]
        .as_object_mut()
        .ok_or_else(|| anyhow!("native orbital construction stage is invalid"))?;
    let delivered_before = stage
        .get("delivered")
        .and_then(Value::as_object)
        .and_then(|delivered| delivered.get(item_id));
    let current = station_integer(delivered_before);
    let remaining = stage
        .get("costs")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .filter(|cost| string_at(cost, "itemId") == Some(item_id))
        .fold(BigUint::zero(), |total, cost| {
            total + positive_difference(station_integer(cost.get("amount")), current.clone())
        });
    let accepted = amount.min(&remaining).clone();
    if accepted.is_zero() {
        return Ok(accepted);
    }
    stage
        .get_mut("delivered")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native orbital construction delivery record is missing"))?
        .insert(
            item_id.to_owned(),
            Value::from(station_integer_text(current + &accepted)),
        );
    let completed = stage_is_complete(stage);
    if completed {
        let next = match stage_id {
            "core" => "dock-building",
            "dock" => "showcase-building",
            _ => "operational",
        };
        station.insert("status".to_owned(), Value::from(next));
    }
    Ok(accepted)
}

fn contract_is_complete(contract: &Map<String, Value>) -> bool {
    contract
        .get("requirements")
        .and_then(Value::as_array)
        .is_some_and(|requirements| {
            requirements
                .iter()
                .filter_map(Value::as_object)
                .all(|requirement| {
                    station_integer(requirement.get("delivered"))
                        >= station_integer(requirement.get("amount"))
                })
        })
}

fn deliver_contract(
    base: &mut Map<String, Value>,
    contract_id: &str,
    item_id: &str,
    amount: &BigUint,
    planet_id: &str,
) -> anyhow::Result<BigUint> {
    if amount.is_zero() {
        return Ok(BigUint::zero());
    }
    let station = base
        .get_mut("orbitalStation")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native orbital station state is missing"))?;
    let contract_index = station
        .get("contractBoard")
        .and_then(Value::as_object)
        .and_then(|board| board.get("accepted"))
        .and_then(Value::as_array)
        .and_then(|contracts| {
            contracts.iter().position(|contract| {
                contract
                    .as_object()
                    .and_then(|contract| string_at(contract, "id"))
                    == Some(contract_id)
            })
        });
    let Some(contract_index) = contract_index else {
        return Ok(BigUint::zero());
    };
    let mut accepted = BigUint::zero();
    {
        let contract = station
            .get_mut("contractBoard")
            .and_then(Value::as_object_mut)
            .and_then(|board| board.get_mut("accepted"))
            .and_then(Value::as_array_mut)
            .and_then(|contracts| contracts.get_mut(contract_index))
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native orbital contract is invalid"))?;
        match string_at(contract, "status") {
            Some("accepted") => {}
            Some("claimable") => return Ok(BigUint::zero()),
            _ => return Ok(BigUint::zero()),
        }
        let requirements = contract
            .get_mut("requirements")
            .and_then(Value::as_array_mut)
            .ok_or_else(|| anyhow!("native orbital contract requirements are missing"))?;
        let mut remaining = amount.clone();
        for requirement in requirements.iter_mut().filter_map(Value::as_object_mut) {
            if remaining.is_zero()
                || string_at(requirement, "itemId") != Some(item_id)
                || !source_planet_allowed(requirement, planet_id)
            {
                continue;
            }
            let required = station_integer(requirement.get("amount"));
            let delivered = station_integer(requirement.get("delivered"));
            let need = positive_difference(required, delivered.clone());
            let moved = if remaining < need {
                remaining.clone()
            } else {
                need
            };
            if moved.is_zero() {
                continue;
            }
            requirement.insert(
                "delivered".to_owned(),
                Value::from(station_integer_text(delivered + &moved)),
            );
            remaining -= &moved;
            accepted += moved;
        }
        if !accepted.is_zero() && contract_is_complete(contract) {
            contract.insert("status".to_owned(), Value::from("claimable"));
        }
    }
    if !accepted.is_zero() {
        let exported = station
            .get_mut("totals")
            .and_then(Value::as_object_mut)
            .and_then(|totals| totals.get_mut("exportedByItem"))
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native orbital export totals are missing"))?;
        let total = station_integer(exported.get(item_id)) + &accepted;
        exported.insert(item_id.to_owned(), Value::from(station_integer_text(total)));
    }
    Ok(accepted)
}

fn add_contract_amount(totals: &mut BTreeMap<String, BigUint>, item_id: &str, amount: &BigUint) {
    if !amount.is_zero() {
        *totals.entry(item_id.to_owned()).or_default() += amount;
    }
}

/// Validate two adjacent exact-window endpoints and return only the material
/// that actually entered accepted contract requirements. An exported-total
/// increase without the same ordered requirement increase is rejected; an
/// entity input or starting inventory can therefore never masquerade as this
/// interval's production budget.
pub(crate) fn pure_idle_contract_consumption_between(
    before: &PureIdleContractEndpoint,
    after: &PureIdleContractEndpoint,
) -> anyhow::Result<PureIdleContractIntervalReceipt> {
    if before.station_status != after.station_status
        || before.rules_version != after.rules_version
        || before.task_day != after.task_day
        || before.last_confirmed_wall_clock_ms != after.last_confirmed_wall_clock_ms
        || before.accepted.len() != after.accepted.len()
    {
        bail!("native pure-idle contract endpoint configuration changed")
    }
    let mut consumed_by_item = BTreeMap::<String, BigUint>::new();
    let mut requirement_deltas = Vec::new();
    let mut claimable_contract_ids = Vec::new();
    for (contract_index, (before_contract, after_contract)) in
        before.accepted.iter().zip(&after.accepted).enumerate()
    {
        if before_contract.config != after_contract.config
            || before_contract.accepted_at_task_day != after_contract.accepted_at_task_day
            || before_contract.requirements.len() != after_contract.requirements.len()
        {
            bail!("native pure-idle contract endpoint row {contract_index} changed configuration")
        }
        for (requirement_index, (before_requirement, after_requirement)) in before_contract
            .requirements
            .iter()
            .zip(&after_contract.requirements)
            .enumerate()
        {
            if before_requirement.config != after_requirement.config
                || after_requirement.delivered < before_requirement.delivered
            {
                bail!(
                    "native pure-idle contract requirement {contract_index}/{requirement_index} changed identity or moved backward"
                )
            }
            let delta = &after_requirement.delivered - &before_requirement.delivered;
            requirement_deltas.push(PureIdleContractRequirementDelta {
                contract_index,
                contract_id: before_contract.config.id.clone(),
                requirement_index,
                item_id: before_requirement.config.item_id.clone(),
                delivered: delta.clone(),
            });
            add_contract_amount(
                &mut consumed_by_item,
                &before_requirement.config.item_id,
                &delta,
            );
        }
        match (before_contract.status, after_contract.status) {
            (PureIdleContractStatus::Accepted, PureIdleContractStatus::Accepted)
            | (PureIdleContractStatus::Claimable, PureIdleContractStatus::Claimable) => {}
            (PureIdleContractStatus::Accepted, PureIdleContractStatus::Claimable) => {
                claimable_contract_ids.push(before_contract.config.id.clone());
            }
            (PureIdleContractStatus::Claimable, PureIdleContractStatus::Accepted) => {
                bail!("native pure-idle contract claimable status moved backward")
            }
        }
        if before_contract.status == PureIdleContractStatus::Claimable
            && before_contract
                .requirements
                .iter()
                .zip(&after_contract.requirements)
                .any(|(before, after)| before.delivered != after.delivered)
        {
            bail!("native pure-idle claimable contract progress changed")
        }
    }
    let item_ids = before
        .exported_by_item
        .keys()
        .chain(after.exported_by_item.keys())
        .chain(consumed_by_item.keys())
        .cloned()
        .collect::<BTreeSet<_>>();
    for item_id in item_ids {
        let before_total = before
            .exported_by_item
            .get(&item_id)
            .cloned()
            .unwrap_or_default();
        let after_total = after
            .exported_by_item
            .get(&item_id)
            .cloned()
            .unwrap_or_default();
        if after_total < before_total {
            bail!("native pure-idle contract export total moved backward")
        }
        let exported = after_total - before_total;
        let delivered = consumed_by_item.get(&item_id).cloned().unwrap_or_default();
        if exported != delivered {
            bail!("native pure-idle contract requirement/export delta is not closed for {item_id}")
        }
    }
    Ok(PureIdleContractIntervalReceipt {
        requirement_deltas,
        consumed_by_item,
        claimable_contract_ids,
    })
}

fn validate_pure_idle_contract_endpoint_for_plan(
    endpoint: &PureIdleContractEndpoint,
) -> anyhow::Result<()> {
    for contract in &endpoint.accepted {
        if contract.config.requirements.len() != contract.requirements.len() {
            bail!("native pure-idle contract endpoint requirement shape is inconsistent")
        }
        for (config, requirement) in contract
            .config
            .requirements
            .iter()
            .zip(&contract.requirements)
        {
            if config != &requirement.config || requirement.delivered > config.amount {
                bail!("native pure-idle contract endpoint requirement is inconsistent")
            }
            if contract.status == PureIdleContractStatus::Accepted
                && (!matches!(config.channel.as_str(), "any")
                    || config
                        .source_planet_ids
                        .as_ref()
                        .is_some_and(|planets| !planets.is_empty()))
            {
                bail!(
                    "native pure-idle contract delivery has an uncertified channel or source planet"
                )
            }
        }
        let complete = contract
            .requirements
            .iter()
            .all(|requirement| requirement.delivered == requirement.config.amount);
        if (contract.status == PureIdleContractStatus::Claimable) != complete {
            bail!("native pure-idle contract endpoint status is inconsistent")
        }
    }
    Ok(())
}

fn bounded_contract_production_budget(
    endpoint: &PureIdleContractEndpoint,
    production_budget_by_item: &BTreeMap<String, BigUint>,
) -> anyhow::Result<(BTreeMap<String, BigUint>, BTreeMap<String, BigUint>)> {
    let maximum_export = maximum_station_integer();
    let mut available_budget_by_item = BTreeMap::<String, BigUint>::new();
    let mut export_limited_by_item = BTreeMap::<String, BigUint>::new();
    for (item_id, budget) in production_budget_by_item {
        if budget.is_zero() {
            continue;
        }
        let current_export = endpoint
            .exported_by_item
            .get(item_id)
            .cloned()
            .unwrap_or_default();
        if current_export > maximum_export {
            bail!("native pure-idle contract export endpoint exceeds its integer bound")
        }
        let capacity = &maximum_export - current_export;
        let available = budget.min(&capacity).clone();
        let clipped = budget - &available;
        if !available.is_zero() {
            available_budget_by_item.insert(item_id.clone(), available);
        }
        if !clipped.is_zero() {
            export_limited_by_item.insert(item_id.clone(), clipped);
        }
    }
    Ok((available_budget_by_item, export_limited_by_item))
}

fn unused_contract_budget(
    production_budget_by_item: &BTreeMap<String, BigUint>,
    consumed_by_item: &BTreeMap<String, BigUint>,
) -> BTreeMap<String, BigUint> {
    production_budget_by_item
        .iter()
        .filter_map(|(item_id, budget)| {
            let consumed = consumed_by_item.get(item_id).cloned().unwrap_or_default();
            let unused = budget - consumed;
            (!unused.is_zero()).then(|| (item_id.clone(), unused))
        })
        .collect()
}

/// Build an immutable, requirement-bound plan from material produced in the
/// caller's current certified window. The budget is never augmented from a
/// tray, terminal input, quantum inventory, or any other starting stock.
///
/// This aggregate convenience path follows accepted/requirement order. A
/// calibrated terminal certificate must use the fixed-step entry point below,
/// because an item aggregate cannot identify which of two same-item contracts
/// was served by the exact windows.
pub(crate) fn plan_certified_pure_idle_contract_delivery(
    endpoint: &PureIdleContractEndpoint,
    production_budget_by_item: &BTreeMap<String, BigUint>,
) -> anyhow::Result<PureIdleContractDeliveryPlan> {
    validate_pure_idle_contract_endpoint_for_plan(endpoint)?;
    let (mut available_budget_by_item, export_limited_by_item) =
        bounded_contract_production_budget(endpoint, production_budget_by_item)?;

    let mut planned_rows = endpoint.accepted.clone();
    let mut steps = Vec::new();
    let mut planned_consumed_by_item = BTreeMap::<String, BigUint>::new();
    let mut boundary = None;
    'contracts: for (contract_index, planned_contract) in planned_rows.iter_mut().enumerate() {
        if planned_contract.status == PureIdleContractStatus::Claimable {
            continue;
        }
        let distance_before_plan = contract_boundary(
            contract_index,
            endpoint
                .accepted
                .get(contract_index)
                .expect("planned contract has endpoint"),
        );
        let mut incomplete_requirements = planned_contract
            .requirements
            .iter()
            .filter(|requirement| requirement.delivered < requirement.config.amount)
            .count();
        for (requirement_index, requirement) in planned_contract.requirements.iter_mut().enumerate()
        {
            let item_id = requirement.config.item_id.clone();
            let expected_delivered = requirement.delivered.clone();
            let need = positive_difference(
                requirement.config.amount.clone(),
                expected_delivered.clone(),
            );
            if need.is_zero() {
                continue;
            }
            let available = available_budget_by_item
                .get(&item_id)
                .cloned()
                .unwrap_or_default();
            let mut amount = available.min(need);
            if amount.is_zero() {
                continue;
            }
            let target_after = &expected_delivered + &amount;
            let closes_requirement = target_after == requirement.config.amount;
            let would_complete = closes_requirement && incomplete_requirements == 1;
            if would_complete {
                amount -= 1_u8;
                boundary = Some(PureIdleContractDeliveryBoundary {
                    contract_index,
                    contract_id: planned_contract.config.id.clone(),
                    requirement_index,
                    item_id: item_id.clone(),
                    reserved_units: BigUint::from(1_u8),
                    distance_before_plan: distance_before_plan.clone(),
                });
            }
            if !amount.is_zero() {
                requirement.delivered += &amount;
                if closes_requirement && !would_complete {
                    incomplete_requirements -= 1;
                }
                *available_budget_by_item.entry(item_id.clone()).or_default() -= &amount;
                add_contract_amount(&mut planned_consumed_by_item, &item_id, &amount);
                steps.push(PureIdleContractDeliveryStep {
                    contract_index,
                    contract_id: planned_contract.config.id.clone(),
                    requirement_index,
                    item_id,
                    expected_delivered,
                    amount,
                });
            }
            if boundary.is_some() {
                break 'contracts;
            }
        }
    }
    let unused_budget_by_item =
        unused_contract_budget(production_budget_by_item, &planned_consumed_by_item);
    Ok(PureIdleContractDeliveryPlan {
        expected_endpoint: endpoint.clone(),
        production_budget_by_item: production_budget_by_item.clone(),
        requested_steps: None,
        steps,
        planned_consumed_by_item,
        unused_budget_by_item,
        export_limited_by_item,
        boundary_limited: boundary.is_some(),
        boundary,
    })
}

/// Build a plan from exact-window target rows. Unlike the aggregate
/// convenience planner, this function never redirects same-item material to
/// an earlier contract. Each requested step is bound to one persisted
/// contract/requirement identity and the endpoint progress observed when the
/// certificate was built.
pub(crate) fn plan_certified_pure_idle_contract_delivery_steps(
    endpoint: &PureIdleContractEndpoint,
    production_budget_by_item: &BTreeMap<String, BigUint>,
    requested_steps: &[PureIdleContractDeliveryStep],
) -> anyhow::Result<PureIdleContractDeliveryPlan> {
    validate_pure_idle_contract_endpoint_for_plan(endpoint)?;
    let (mut available_budget_by_item, export_limited_by_item) =
        bounded_contract_production_budget(endpoint, production_budget_by_item)?;
    let mut planned_rows = endpoint.accepted.clone();
    let mut steps = Vec::with_capacity(requested_steps.len());
    let mut planned_consumed_by_item = BTreeMap::<String, BigUint>::new();
    let mut seen_targets = BTreeSet::<(usize, usize)>::new();
    let mut last_target = None;
    let mut boundary = None;
    for requested in requested_steps {
        if requested.amount.is_zero() {
            bail!("native pure-idle fixed contract delivery step is zero")
        }
        let target = (requested.contract_index, requested.requirement_index);
        if last_target.is_some_and(|last| target <= last) || !seen_targets.insert(target) {
            bail!("native pure-idle fixed contract delivery steps are not in persisted order")
        }
        last_target = Some(target);
        let contract = planned_rows
            .get(requested.contract_index)
            .ok_or_else(|| anyhow!("native pure-idle fixed contract target is missing"))?;
        if contract.config.id != requested.contract_id
            || contract.status != PureIdleContractStatus::Accepted
        {
            bail!("native pure-idle fixed contract target identity is stale")
        }
        let requirement = contract
            .requirements
            .get(requested.requirement_index)
            .ok_or_else(|| anyhow!("native pure-idle fixed contract requirement is missing"))?;
        if requirement.config.item_id != requested.item_id
            || requirement.delivered != requested.expected_delivered
        {
            bail!("native pure-idle fixed contract requirement endpoint is stale")
        }
        let first_pending_same_item = contract
            .requirements
            .iter()
            .enumerate()
            .find(|(_, candidate)| {
                candidate.config.item_id == requested.item_id
                    && candidate.delivered < candidate.config.amount
            })
            .map(|(index, _)| index);
        if first_pending_same_item != Some(requested.requirement_index) {
            bail!(
                "native pure-idle fixed contract target is not the first deliverable same-item requirement"
            )
        }
        let need = positive_difference(
            requirement.config.amount.clone(),
            requirement.delivered.clone(),
        );
        let available = available_budget_by_item
            .get(&requested.item_id)
            .cloned()
            .unwrap_or_default();
        let mut amount = requested.amount.clone().min(available).min(need);
        if amount.is_zero() {
            continue;
        }
        let target_after = &requested.expected_delivered + &amount;
        let would_complete =
            contract
                .requirements
                .iter()
                .enumerate()
                .all(|(requirement_index, candidate)| {
                    if requirement_index == requested.requirement_index {
                        target_after == candidate.config.amount
                    } else {
                        candidate.delivered == candidate.config.amount
                    }
                });
        if would_complete {
            amount -= 1_u8;
            boundary = Some(PureIdleContractDeliveryBoundary {
                contract_index: requested.contract_index,
                contract_id: requested.contract_id.clone(),
                requirement_index: requested.requirement_index,
                item_id: requested.item_id.clone(),
                reserved_units: BigUint::from(1_u8),
                distance_before_plan: contract_boundary(requested.contract_index, contract),
            });
        }
        if !amount.is_zero() {
            planned_rows[requested.contract_index].requirements[requested.requirement_index]
                .delivered += &amount;
            *available_budget_by_item
                .entry(requested.item_id.clone())
                .or_default() -= &amount;
            add_contract_amount(&mut planned_consumed_by_item, &requested.item_id, &amount);
            steps.push(PureIdleContractDeliveryStep {
                contract_index: requested.contract_index,
                contract_id: requested.contract_id.clone(),
                requirement_index: requested.requirement_index,
                item_id: requested.item_id.clone(),
                expected_delivered: requested.expected_delivered.clone(),
                amount,
            });
        }
        if boundary.is_some() {
            break;
        }
    }
    let unused_budget_by_item =
        unused_contract_budget(production_budget_by_item, &planned_consumed_by_item);
    Ok(PureIdleContractDeliveryPlan {
        expected_endpoint: endpoint.clone(),
        production_budget_by_item: production_budget_by_item.clone(),
        requested_steps: Some(requested_steps.to_vec()),
        steps,
        planned_consumed_by_item,
        unused_budget_by_item,
        export_limited_by_item,
        boundary_limited: boundary.is_some(),
        boundary,
    })
}

/// Apply a previously captured plan to an isolated station clone, audit every
/// requirement and export-total delta, and only then replace the live station.
/// Any stale endpoint, malformed row, status transition, or saturation leaves
/// the source CoreState byte-for-byte untouched.
pub(crate) fn apply_certified_pure_idle_contract_delivery(
    state: &mut CoreState,
    plan: &PureIdleContractDeliveryPlan,
) -> anyhow::Result<PureIdleContractDeliveryReceipt> {
    let observed = capture_pure_idle_contract_endpoint(state)?;
    if observed != plan.expected_endpoint {
        bail!("native pure-idle contract endpoint diverged from its delivery plan")
    }
    let rebuilt = if let Some(requested_steps) = &plan.requested_steps {
        plan_certified_pure_idle_contract_delivery_steps(
            &observed,
            &plan.production_budget_by_item,
            requested_steps,
        )?
    } else {
        plan_certified_pure_idle_contract_delivery(&observed, &plan.production_budget_by_item)?
    };
    if &rebuilt != plan {
        bail!("native pure-idle contract delivery plan is not canonical")
    }
    if plan.steps.is_empty() {
        return Ok(PureIdleContractDeliveryReceipt {
            consumed_by_item: BTreeMap::new(),
            unused_budget_by_item: plan.unused_budget_by_item.clone(),
            export_limited_by_item: plan.export_limited_by_item.clone(),
            boundary_limited: plan.boundary_limited,
            boundary: plan.boundary.clone(),
            endpoint_before: observed.clone(),
            endpoint_after: observed,
        });
    }

    let base = state.base_value();
    let candidate_station = station_object(base)
        .cloned()
        .ok_or_else(|| anyhow!("native pure-idle orbital station state is missing"))?;
    let mut candidate_base = Map::new();
    candidate_base.insert(
        "orbitalStation".to_owned(),
        Value::Object(candidate_station),
    );
    for step in &plan.steps {
        let requirements_before = candidate_base
            .get("orbitalStation")
            .and_then(Value::as_object)
            .and_then(|station| station.get("contractBoard"))
            .and_then(Value::as_object)
            .and_then(|board| board.get("accepted"))
            .and_then(Value::as_array)
            .and_then(|contracts| contracts.get(step.contract_index))
            .and_then(Value::as_object)
            .ok_or_else(|| anyhow!("native pure-idle planned contract disappeared"))?;
        if string_at(requirements_before, "id") != Some(step.contract_id.as_str())
            || string_at(requirements_before, "status") != Some("accepted")
        {
            bail!("native pure-idle planned contract identity changed")
        }
        let before_progress = requirements_before
            .get("requirements")
            .and_then(Value::as_array)
            .ok_or_else(|| anyhow!("native pure-idle planned requirements disappeared"))?
            .iter()
            .map(|requirement| {
                let requirement = requirement
                    .as_object()
                    .ok_or_else(|| anyhow!("native pure-idle planned requirement is invalid"))?;
                strict_contract_integer(requirement.get("delivered"), "planned contract delivered")
            })
            .collect::<anyhow::Result<Vec<_>>>()?;
        if before_progress.get(step.requirement_index) != Some(&step.expected_delivered) {
            bail!("native pure-idle planned requirement endpoint changed")
        }
        let moved = deliver_contract(
            &mut candidate_base,
            &step.contract_id,
            &step.item_id,
            &step.amount,
            "",
        )?;
        if moved != step.amount {
            bail!("native pure-idle planned contract delivery was clipped during replay")
        }
        let contract_after = candidate_base
            .get("orbitalStation")
            .and_then(Value::as_object)
            .and_then(|station| station.get("contractBoard"))
            .and_then(Value::as_object)
            .and_then(|board| board.get("accepted"))
            .and_then(Value::as_array)
            .and_then(|contracts| contracts.get(step.contract_index))
            .and_then(Value::as_object)
            .ok_or_else(|| anyhow!("native pure-idle delivered contract disappeared"))?;
        if string_at(contract_after, "id") != Some(step.contract_id.as_str())
            || string_at(contract_after, "status") != Some("accepted")
        {
            bail!("native pure-idle contract crossed a claimable boundary")
        }
        let after_progress = contract_after
            .get("requirements")
            .and_then(Value::as_array)
            .ok_or_else(|| anyhow!("native pure-idle delivered requirements disappeared"))?
            .iter()
            .map(|requirement| {
                let requirement = requirement
                    .as_object()
                    .ok_or_else(|| anyhow!("native pure-idle delivered requirement is invalid"))?;
                strict_contract_integer(requirement.get("delivered"), "delivered contract progress")
            })
            .collect::<anyhow::Result<Vec<_>>>()?;
        if after_progress.len() != before_progress.len() {
            bail!("native pure-idle contract requirement shape changed during delivery")
        }
        for (index, (before, after)) in before_progress.iter().zip(&after_progress).enumerate() {
            let expected = if index == step.requirement_index {
                before + &step.amount
            } else {
                before.clone()
            };
            if *after != expected {
                bail!("native pure-idle delivery touched a different requirement")
            }
        }
    }
    let candidate_station = candidate_base
        .get("orbitalStation")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native pure-idle candidate station disappeared"))?;
    let endpoint_after = capture_pure_idle_contract_endpoint_from_station(
        state,
        state.base_value(),
        candidate_station,
    )?;
    let interval = pure_idle_contract_consumption_between(&observed, &endpoint_after)?;
    if interval.consumed_by_item != plan.planned_consumed_by_item
        || !interval.claimable_contract_ids.is_empty()
        || endpoint_after.config_snapshot() != observed.config_snapshot()
    {
        bail!("native pure-idle contract delivery receipt failed its closed-ledger audit")
    }
    let committed_station = candidate_base
        .remove("orbitalStation")
        .ok_or_else(|| anyhow!("native pure-idle candidate station disappeared"))?;
    state
        .base_value_mut()
        .insert("orbitalStation".to_owned(), committed_station);
    Ok(PureIdleContractDeliveryReceipt {
        consumed_by_item: interval.consumed_by_item,
        unused_budget_by_item: plan.unused_budget_by_item.clone(),
        export_limited_by_item: plan.export_limited_by_item.clone(),
        boundary_limited: plan.boundary_limited,
        boundary: plan.boundary.clone(),
        endpoint_before: observed,
        endpoint_after,
    })
}

fn deliver_item(
    base: &mut Map<String, Value>,
    binding: &Value,
    item_id: &str,
    amount: &BigUint,
    planet_id: &str,
) -> anyhow::Result<BigUint> {
    if binding_is_construction(binding) {
        deliver_construction(base, item_id, amount)
    } else if let Some(contract_id) = binding_contract_id(binding) {
        deliver_contract(base, contract_id, item_id, amount, planet_id)
    } else {
        Ok(BigUint::zero())
    }
}

fn reconcile_binding(
    base: &Map<String, Value>,
    entity: &mut Map<String, Value>,
) -> anyhow::Result<()> {
    if binding_is_valid(base, entity.get("orbitalCargoBinding")) {
        return Ok(());
    }
    entity.insert("orbitalCargoBinding".to_owned(), Value::Null);
    set_number(entity, "orbitalCargoProgress", 0.0)
}

fn collect_ordered_terminal_probes_with_runtime<R, F>(
    runtime: &DeterministicRuntime,
    entity_indices: &[usize],
    probe: F,
) -> anyhow::Result<Vec<R>>
where
    R: Send,
    F: Fn(usize) -> anyhow::Result<R> + Send + Sync,
{
    // Collect every result before choosing an error. `indexed_map` retains
    // the topology order, so a parallel failure always reports the lowest
    // original terminal position instead of the first worker to finish.
    runtime
        .indexed_map(entity_indices, |_, entity_index| probe(*entity_index))
        .into_iter()
        .collect()
}

fn probe_terminal(
    state: &CoreState,
    base: &Map<String, Value>,
    entities: &[Value],
    entity_index: usize,
) -> anyhow::Result<TerminalProbe> {
    let entity = entities
        .get(entity_index)
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native orbital cargo terminal is invalid"))?;
    let binding = entity
        .get("orbitalCargoBinding")
        .cloned()
        .unwrap_or(Value::Null);
    let binding_valid = binding_is_valid(base, Some(&binding));
    if !binding_valid || binding.is_null() {
        return Ok(TerminalProbe {
            entity_index,
            reconcile_binding: !binding_valid,
            active: None,
        });
    }

    let ports = port_items(state, entity);
    let buffered = entity.get("inputs").and_then(Value::as_object);
    let mut seen = Vec::<String>::with_capacity(PORT_COUNT);
    let mut requests = Vec::<CargoRequestProbe>::with_capacity(PORT_COUNT);
    for (port_index, item_id) in ports.into_iter().enumerate() {
        let Some(item_id) = item_id else {
            continue;
        };
        if seen.iter().any(|seen| seen == &item_id) {
            continue;
        }
        seen.push(item_id.clone());
        requests.push(CargoRequestProbe {
            buffered_amount: finite_number(buffered.and_then(|inputs| inputs.get(&item_id)))
                .floor()
                .max(0.0) as u64,
            item_id,
            port_index,
        });
    }

    Ok(TerminalProbe {
        entity_index,
        reconcile_binding: false,
        active: Some(ActiveTerminalProbe {
            entity_index,
            entity_id: string_at(entity, "id").map(str::to_owned),
            binding,
            planet_id: string_at(entity, "planetId").unwrap_or_default().to_owned(),
            power_factor: finite_number(entity.get("powerFactor")).clamp(0.0, 1.0),
            progress: finite_number(entity.get("orbitalCargoProgress")).max(0.0),
            routing_cursor: finite_number(entity.get("routingCursor")).floor().max(0.0) as usize
                % PORT_COUNT,
            requests,
        }),
    })
}

fn next_active_port(inputs: &[CargoInput], active: &[usize], after_port: usize) -> Option<usize> {
    (0..PORT_COUNT)
        .map(|offset| (after_port + offset + 1) % PORT_COUNT)
        .find(|port| {
            active.iter().any(|index| {
                inputs[*index].port_index == *port && !inputs[*index].available.is_zero()
            })
        })
}

fn settle_with_runtime(
    runtime: &DeterministicRuntime,
    state: &CoreState,
    base: &mut Map<String, Value>,
    entities: &mut [Value],
    seconds: f64,
) -> anyhow::Result<()> {
    if base.get("mode").and_then(Value::as_str) != Some("normal")
        || base.get("paused").and_then(Value::as_bool).unwrap_or(false)
        || seconds <= 0.0
        || !seconds.is_finite()
        || station_status(base) == "locked"
    {
        return Ok(());
    }
    // Entity-local terminal snapshots are independent. Parse and normalize
    // them on the shared deterministic pool, then replay every shared target,
    // inventory and cursor mutation in the original ID order below. Nothing
    // is written until all probes (and the lowest-index error) are known.
    let probes = collect_ordered_terminal_probes_with_runtime(
        runtime,
        &state.factory_topology.orbital_cargo_terminal_indices,
        |entity_index| probe_terminal(state, base, entities, entity_index),
    )?;
    for probe in &probes {
        if !probe.reconcile_binding {
            continue;
        }
        let entity = entities[probe.entity_index]
            .as_object_mut()
            .expect("validated orbital cargo terminal disappeared before replay");
        reconcile_binding(base, entity)?;
    }
    let mut terminals = probes
        .into_iter()
        .filter_map(|probe| probe.active)
        .collect::<Vec<_>>();
    terminals.sort_by(|left, right| left.entity_id.cmp(&right.entity_id));
    if terminals.is_empty() {
        return Ok(());
    }
    for terminal in terminals {
        let ActiveTerminalProbe {
            entity_index,
            binding,
            planet_id,
            power_factor,
            progress,
            routing_cursor,
            requests,
            ..
        } = terminal;
        let mut inputs = Vec::<CargoInput>::new();
        for request in requests {
            let remaining = target_remaining(base, Some(&binding), &request.item_id, &planet_id);
            let available = BigUint::from(request.buffered_amount).min(remaining);
            if !available.is_zero() {
                inputs.push(CargoInput {
                    item_id: request.item_id,
                    port_index: request.port_index,
                    available,
                    planned: BigUint::zero(),
                });
            }
        }
        if power_factor <= 0.0 || inputs.is_empty() {
            let entity = entities[entity_index]
                .as_object_mut()
                .expect("validated terminal");
            set_number(entity, "utilization", 0.0)?;
            set_number(entity, "productionRate", 0.0)?;
            continue;
        }
        let accumulated = progress + UPLOAD_PER_MINUTE * seconds * power_factor / 60.0;
        let budget = (accumulated + 1e-9).floor().max(0.0) as u64;
        let fractional = (accumulated - budget as f64).clamp(0.0, 0.999_999_999);
        let mut remaining_budget = BigUint::from(budget);
        let mut cursor = routing_cursor;
        while !remaining_budget.is_zero() {
            let active = inputs
                .iter()
                .enumerate()
                .filter_map(|(index, input)| (!input.available.is_zero()).then_some(index))
                .collect::<Vec<_>>();
            if active.is_empty() {
                break;
            }
            let mut ordered_active = active.clone();
            ordered_active.sort_by_key(|index| {
                (inputs[*index].port_index + PORT_COUNT - cursor) % PORT_COUNT
            });
            let count = BigUint::from(active.len());
            let full_rounds = &remaining_budget / &count;
            let minimum = active
                .iter()
                .map(|index| inputs[*index].available.clone())
                .min()
                .unwrap_or_default();
            let rounds = full_rounds.min(minimum);
            if !rounds.is_zero() {
                for &index in &active {
                    inputs[index].available -= &rounds;
                    inputs[index].planned += &rounds;
                }
                remaining_budget -= &rounds * &count;
                let last_port = inputs[*ordered_active.last().expect("active cargo")].port_index;
                cursor = next_active_port(&inputs, &active, last_port)
                    .unwrap_or((last_port + 1) % PORT_COUNT);
                continue;
            }
            let start_cursor = cursor;
            let mut allocated = false;
            for offset in 0..PORT_COUNT {
                if remaining_budget.is_zero() {
                    break;
                }
                let port = (start_cursor + offset) % PORT_COUNT;
                let Some(index) = active.iter().copied().find(|index| {
                    inputs[*index].port_index == port && !inputs[*index].available.is_zero()
                }) else {
                    continue;
                };
                inputs[index].available -= 1_u8;
                inputs[index].planned += 1_u8;
                remaining_budget -= 1_u8;
                cursor =
                    next_active_port(&inputs, &active, port).unwrap_or((port + 1) % PORT_COUNT);
                allocated = true;
            }
            if !allocated {
                break;
            }
        }
        let mut uploaded = BigUint::zero();
        for input in &inputs {
            if input.planned.is_zero() {
                continue;
            }
            let accepted =
                deliver_item(base, &binding, &input.item_id, &input.planned, &planet_id)?;
            if accepted.is_zero() {
                continue;
            }
            let accepted_number = accepted
                .to_u64()
                .ok_or_else(|| anyhow!("native orbital cargo accepted amount exceeds u64"))?
                as f64;
            let entity = entities[entity_index]
                .as_object_mut()
                .expect("validated terminal");
            let current = entity
                .get("inputs")
                .and_then(Value::as_object)
                .and_then(|inputs| inputs.get(&input.item_id))
                .map(|value| finite_number(Some(value)).floor().max(0.0))
                .unwrap_or(0.0);
            entity
                .get_mut("inputs")
                .and_then(Value::as_object_mut)
                .expect("validated terminal inputs")
                .insert(
                    input.item_id.clone(),
                    Value::from((current - accepted_number).max(0.0)),
                );
            uploaded += accepted;
        }
        let entity = entities[entity_index]
            .as_object_mut()
            .expect("validated terminal");
        set_number(entity, "orbitalCargoProgress", fractional)?;
        set_number(entity, "routingCursor", cursor as f64)?;
        let total = station_integer(entity.get("orbitalCargoTotalUploaded")) + &uploaded;
        entity.insert(
            "orbitalCargoTotalUploaded".to_owned(),
            Value::from(station_integer_text(total)),
        );
        let uploaded_number = uploaded
            .to_u64()
            .ok_or_else(|| anyhow!("native orbital cargo upload exceeds u64"))?
            as f64;
        set_number(
            entity,
            "utilization",
            if uploaded.is_zero() {
                0.0
            } else {
                power_factor
            },
        )?;
        set_number(entity, "productionRate", uploaded_number * 60.0 / seconds)?;
    }
    crate::station_contracts::synchronize(state, base)?;
    for &index in &state.factory_topology.orbital_cargo_terminal_indices {
        let entity = entities[index]
            .as_object_mut()
            .ok_or_else(|| anyhow!("native orbital cargo terminal is invalid"))?;
        reconcile_binding(base, entity)?;
    }
    Ok(())
}

pub(crate) fn settle(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entities: &mut [Value],
    seconds: f64,
) -> anyhow::Result<()> {
    settle_with_runtime(deterministic_runtime(), state, base, entities, seconds)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::{
        BeltDefinition, BuildingDefinition, CatalogSnapshot, ItemDefinition, PlanetDefinition,
        RuntimeCatalog,
    };
    use crate::deterministic_runtime::PARALLEL_MIN_ITEMS;
    use crate::state::CoreCheckpointIdentity;
    use serde_json::json;
    use std::collections::{BTreeMap, HashMap};
    use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};

    fn fixture_checksum(bytes: &[u8]) -> String {
        let mut hash = 0x811c9dc5_u32;
        for byte in bytes {
            hash ^= u32::from(*byte);
            hash = hash.wrapping_mul(0x01000193);
        }
        format!("{hash:08x}")
    }

    fn fixture_catalog() -> RuntimeCatalog {
        RuntimeCatalog::validate(
            CatalogSnapshot {
                protocol_version: 1,
                registry_fingerprint: "orbital-terminal-parallel-test".to_owned(),
                planets: vec![PlanetDefinition {
                    id: "home".to_owned(),
                    name: "home".to_owned(),
                    system_id: "helios".to_owned(),
                    kind: "terrestrial".to_owned(),
                    orbit_index: 1,
                    simulation_order: 0,
                    orbital_yields: HashMap::new(),
                }],
                items: ["iron_ore", "copper_ingot"]
                    .into_iter()
                    .map(|item_id| ItemDefinition {
                        id: item_id.to_owned(),
                        name: item_id.to_owned(),
                        kind: "solid".to_owned(),
                        fuel_energy_mj: 0.0,
                    })
                    .collect(),
                buildings: vec![BuildingDefinition {
                    id: "orbital_cargo_terminal".to_owned(),
                    kind: "storage".to_owned(),
                    speed: 1.0,
                    input_capacity: 1_000_000.0,
                    output_capacity: 0.0,
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
            "orbital-terminal-parallel-test",
        )
        .unwrap()
    }

    fn fixture_base() -> Value {
        json!({
            "version": 47,
            "mode": "normal",
            "paused": false,
            "activePlanetId": "home",
            "exploration": { "colonizedPlanetIds": ["home"] },
            "orbitalStation": {
                "status": "core-building",
                "construction": {
                    "stageRequirements": [{
                        "stageId": "core",
                        "costs": [{ "itemId": "iron_ore", "amount": "1000000000" }],
                        "delivered": { "iron_ore": "0" },
                        "fleetCosts": {},
                        "deliveredFleet": {}
                    }]
                },
                "contractBoard": {
                    "taskDay": 0,
                    "lastConfirmedWallClockMs": 0,
                    "offers": [],
                    "accepted": [],
                    "history": [],
                    "settledIds": []
                },
                "totals": { "exportedByItem": {} }
            },
            "mod:base/opaque": { "signedZero": -0.0, "text": "必须保持原样" }
        })
    }

    fn contract_requirement(
        item_id: &str,
        amount: u64,
        delivered: u64,
        channel: &str,
        source_planet_ids: Option<Vec<&str>>,
    ) -> Value {
        let mut value = json!({
            "itemId": item_id,
            "amount": amount.to_string(),
            "delivered": delivered.to_string(),
            "channel": channel,
            "weight": 1
        });
        if let Some(planets) = source_planet_ids {
            value.as_object_mut().unwrap().insert(
                "sourcePlanetIds".to_owned(),
                Value::Array(planets.into_iter().map(Value::from).collect()),
            );
        }
        value
    }

    fn accepted_contract_fixture(
        slot: u64,
        template_id: &str,
        status: &str,
        requirements: Vec<Value>,
    ) -> Value {
        let special = slot == 3;
        let multiplier = if special { 2 } else { 1 };
        json!({
            "id": format!("station-contract-v1-7-100-{slot}-{template_id}"),
            "templateId": template_id,
            "slot": slot,
            "title": format!("contract {slot}"),
            "summary": "certified contract fixture",
            "taskDay": 100,
            "expiresAtTaskDay": 103,
            "special": special,
            "difficulty": "P1",
            "status": status,
            "requirements": requirements,
            "rewards": {
                "baseMarks": (45 * multiplier).to_string(),
                "baseReputation": (30 * multiplier).to_string(),
                "completionMarks": (20 * multiplier).to_string(),
                "completionReputation": (15 * multiplier).to_string()
            },
            "acceptedAtTaskDay": 100
        })
    }

    fn contract_fixture_base(contracts: Vec<Value>, exported: Value) -> Value {
        let mut base = fixture_base();
        base["galaxy"] = json!({ "seed": 7 });
        base["tray"] = json!({ "iron_ore": 999_999_999, "copper_ingot": 999_999_999 });
        base["planetTrays"] = json!({
            "home": { "iron_ore": 999_999_999, "copper_ingot": 999_999_999 }
        });
        base["quantumLogisticsNetwork"] = json!({
            "enabled": true,
            "inventory": { "iron_ore": "999999999", "copper_ingot": "999999999" }
        });
        base["orbitalStation"]["status"] = json!("operational");
        base["orbitalStation"]["contractBoard"] = json!({
            "rulesVersion": 1,
            "taskDay": 100,
            "lastConfirmedWallClockMs": 8_640_000_000_u64,
            "offers": [],
            "accepted": contracts,
            "history": [],
            "settledIds": [],
            "featuredContractId": null
        });
        base["orbitalStation"]["totals"] = json!({
            "completedContracts": 0,
            "exportedByItem": exported
        });
        base["orbitalStation"]["economy"] = json!({
            "orbitalMarks": "0",
            "stationReputation": "0"
        });
        base
    }

    fn contract_terminal(contract_id: &str) -> Value {
        let mut terminal = terminal_entity(0, 1);
        terminal["inputs"] = json!({ "iron_ore": 888_888_888, "copper_ingot": 777_777_777 });
        terminal["orbitalCargoBinding"] = json!({ "kind": "contract", "contractId": contract_id });
        terminal["orbitalCargoProgress"] = json!(0.875);
        terminal["routingCursor"] = json!(3);
        terminal
    }

    fn terminal_entity(index: usize, count: usize) -> Value {
        let buffered = 200 + index % 37;
        json!({
            "id": format!("terminal/{:05}/Ω", count - index),
            "kind": "storage",
            "planetId": "home",
            "buildingId": "orbital_cargo_terminal",
            "inputs": { "iron_ore": buffered },
            "outputs": {},
            "powerFactor": if index.is_multiple_of(41) { 0.0 } else { 0.25 + (index % 4) as f64 * 0.25 },
            "orbitalCargoProgress": (index % 13) as f64 / 13.0,
            "routingCursor": index % PORT_COUNT,
            "orbitalCargoTotalUploaded": "0",
            "orbitalCargoBinding": { "kind": "construction" },
            "orbitalCargoPortItems": ["iron_ore", "iron_ore", null, null],
            "utilization": -1,
            "productionRate": -1,
            "mod:terminal/opaque": {
                "index": index,
                "signedZero": -0.0,
                "text": "保持原样"
            }
        })
    }

    fn terminal_matrix(count: usize) -> Vec<Value> {
        (0..count)
            .map(|index| terminal_entity(index, count))
            .collect()
    }

    fn fixture_state_with_base(base_value: Value, entities: &[Value]) -> CoreState {
        let entity_count = entities.len();
        let base = serde_json::to_vec(&base_value).unwrap();
        let entities = serde_json::to_vec(entities).unwrap();
        let belts = serde_json::to_vec(&Vec::<Value>::new()).unwrap();
        let chunks = [
            ("base", "base", &base, 0, 1),
            ("entities:00000000", "entities", &entities, 0, entity_count),
            ("belts:00000000", "belts", &belts, 0, 0),
        ]
        .into_iter()
        .map(|(id, kind, bytes, offset, count)| {
            json!({
                "id": id,
                "kind": kind,
                "offset": offset,
                "count": count,
                "checksum": fixture_checksum(bytes),
                "bytes": bytes.len()
            })
        })
        .collect::<Vec<_>>();
        let manifest = serde_json::to_vec(&json!({
            "formatVersion": 1,
            "envelopeFormatVersion": 2,
            "mode": "normal",
            "slot": "main",
            "stateVersion": 47,
            "savedAt": 1,
            "basePrimaryChecksum": "12345678",
            "chunkRootChecksum": "12345678",
            "totalBytes": base.len() + entities.len() + belts.len(),
            "entityCount": entity_count,
            "beltCount": 0,
            "chunks": chunks
        }))
        .unwrap();
        let records = BTreeMap::from([
            (
                "dsp-idle-network.internal.v1.chunked.v1.normal.manifest".to_owned(),
                manifest,
            ),
            (
                "dsp-idle-network.internal.v1.chunked.v1.normal.chunk.base".to_owned(),
                base,
            ),
            (
                "dsp-idle-network.internal.v1.chunked.v1.normal.chunk.entities%3A00000000"
                    .to_owned(),
                entities,
            ),
            (
                "dsp-idle-network.internal.v1.chunked.v1.normal.chunk.belts%3A00000000".to_owned(),
                belts,
            ),
        ]);
        CoreState::from_internal_records(
            CoreCheckpointIdentity {
                slot: "normal-main".to_owned(),
                generation: 1,
                root_hash: "a".repeat(64),
                revision: 7,
                state_version: 47,
                mode: "normal".to_owned(),
                registry_fingerprint: "orbital-terminal-parallel-test".to_owned(),
                base_primary_checksum: "12345678".to_owned(),
            },
            &records,
            fixture_catalog(),
        )
        .unwrap()
    }

    fn fixture_state(entities: &[Value]) -> CoreState {
        fixture_state_with_base(fixture_base(), entities)
    }

    fn run_terminal_matrix(
        state: &CoreState,
        source: &[Value],
        worker_count: usize,
    ) -> (Value, Vec<Value>) {
        let runtime = DeterministicRuntime::for_test(worker_count);
        let mut base = fixture_base();
        let mut entities = source.to_vec();
        settle_with_runtime(
            &runtime,
            state,
            base.as_object_mut().unwrap(),
            &mut entities,
            0.375,
        )
        .unwrap();
        (base, entities)
    }

    #[test]
    fn terminal_probe_and_serial_replay_are_byte_exact_at_all_worker_limits() {
        let source = terminal_matrix(PARALLEL_MIN_ITEMS + 137);
        let state = fixture_state(&source);
        let state_hash = state.canonical_sha256().unwrap();
        assert_eq!(
            state.factory_topology.orbital_cargo_terminal_indices.len(),
            source.len()
        );

        let baseline = run_terminal_matrix(&state, &source, 1);
        let baseline_bytes = serde_json::to_vec(&baseline).unwrap();
        for worker_count in [2, 4, 8] {
            let observed = run_terminal_matrix(&state, &source, worker_count);
            assert_eq!(
                serde_json::to_vec(&observed).unwrap(),
                baseline_bytes,
                "orbital terminal state diverged for {worker_count} workers"
            );
        }

        assert_eq!(state.canonical_sha256().unwrap(), state_hash);
        assert_ne!(baseline.1, source);
        assert!(
            station_integer(
                baseline
                    .0
                    .get("orbitalStation")
                    .and_then(Value::as_object)
                    .and_then(|station| station.get("construction"))
                    .and_then(Value::as_object)
                    .and_then(|construction| construction.get("stageRequirements"))
                    .and_then(Value::as_array)
                    .and_then(|stages| stages.first())
                    .and_then(Value::as_object)
                    .and_then(|stage| stage.get("delivered"))
                    .and_then(Value::as_object)
                    .and_then(|delivered| delivered.get("iron_ore"))
            ) > BigUint::zero()
        );
        for (before, after) in source.iter().zip(&baseline.1) {
            assert_eq!(
                serde_json::to_vec(&before["mod:terminal/opaque"]).unwrap(),
                serde_json::to_vec(&after["mod:terminal/opaque"]).unwrap()
            );
        }
    }

    #[test]
    fn large_probe_batches_enter_rayon_and_small_batches_stay_serial() {
        let large = (0..PARALLEL_MIN_ITEMS + 73).collect::<Vec<_>>();
        let large_saw_worker = AtomicBool::new(false);
        let observed = collect_ordered_terminal_probes_with_runtime(
            &DeterministicRuntime::for_test(8),
            &large,
            |entity_index| {
                if rayon::current_thread_index().is_some() {
                    large_saw_worker.store(true, AtomicOrdering::SeqCst);
                }
                Ok(entity_index)
            },
        )
        .unwrap();
        assert_eq!(observed, large);
        assert!(large_saw_worker.load(AtomicOrdering::SeqCst));

        let small = (0..31).collect::<Vec<_>>();
        let small_saw_worker = AtomicBool::new(false);
        let observed = collect_ordered_terminal_probes_with_runtime(
            &DeterministicRuntime::for_test(8),
            &small,
            |entity_index| {
                if rayon::current_thread_index().is_some() {
                    small_saw_worker.store(true, AtomicOrdering::SeqCst);
                }
                Ok(entity_index)
            },
        )
        .unwrap();
        assert_eq!(observed, small);
        assert!(!small_saw_worker.load(AtomicOrdering::SeqCst));
    }

    #[test]
    fn parallel_probe_failure_uses_lowest_index_and_leaves_candidate_unchanged() {
        let indices = (0..PARALLEL_MIN_ITEMS + 97).collect::<Vec<_>>();
        for worker_count in [1, 2, 4, 8] {
            let later_visited = AtomicBool::new(false);
            let error = collect_ordered_terminal_probes_with_runtime(
                &DeterministicRuntime::for_test(worker_count),
                &indices,
                |entity_index| {
                    if entity_index == PARALLEL_MIN_ITEMS + 41 {
                        later_visited.store(true, AtomicOrdering::SeqCst);
                        return Err(anyhow!("later terminal failure"));
                    }
                    if entity_index == 7 {
                        return Err(anyhow!("lowest terminal failure"));
                    }
                    Ok(entity_index)
                },
            )
            .unwrap_err();
            assert_eq!(error.to_string(), "lowest terminal failure");
            assert!(later_visited.load(AtomicOrdering::SeqCst));
        }

        let source = terminal_matrix(PARALLEL_MIN_ITEMS + 97);
        let state = fixture_state(&source);
        let state_hash = state.canonical_sha256().unwrap();
        for worker_count in [1, 2, 4, 8] {
            let mut base = fixture_base();
            let mut candidate = source.clone();
            candidate[1]["orbitalCargoBinding"] = json!({ "kind": "invalid" });
            candidate[7] = Value::Null;
            candidate[PARALLEL_MIN_ITEMS + 41] = Value::Null;
            let base_bytes = serde_json::to_vec(&base).unwrap();
            let candidate_bytes = serde_json::to_vec(&candidate).unwrap();
            let error = settle_with_runtime(
                &DeterministicRuntime::for_test(worker_count),
                &state,
                base.as_object_mut().unwrap(),
                &mut candidate,
                1.0,
            )
            .unwrap_err();
            assert_eq!(
                error.to_string(),
                "native orbital cargo terminal is invalid"
            );
            assert_eq!(serde_json::to_vec(&base).unwrap(), base_bytes);
            assert_eq!(serde_json::to_vec(&candidate).unwrap(), candidate_bytes);
            assert_eq!(state.canonical_sha256().unwrap(), state_hash);
        }
    }

    #[test]
    fn certified_contract_delivery_uses_only_the_window_budget_and_ignores_prefill() {
        let contract = accepted_contract_fixture(
            0,
            "single",
            "accepted",
            vec![contract_requirement("iron_ore", 100, 0, "any", None)],
        );
        let contract_id = contract["id"].as_str().unwrap().to_owned();
        let terminal = contract_terminal(&contract_id);
        let mut state = fixture_state_with_base(
            contract_fixture_base(vec![contract], json!({})),
            std::slice::from_ref(&terminal),
        );
        let prefills = (
            state.base_value()["tray"].clone(),
            state.base_value()["planetTrays"].clone(),
            state.base_value()["quantumLogisticsNetwork"].clone(),
            state.parse_entity(0).unwrap(),
        );
        let source_hash = state.canonical_sha256().unwrap();
        let endpoint = capture_pure_idle_contract_endpoint(&state).unwrap();
        assert_eq!(
            endpoint
                .first_claimable_boundary
                .as_ref()
                .unwrap()
                .remaining_total,
            BigUint::from(100_u64)
        );

        let empty_plan = plan_certified_pure_idle_contract_delivery(
            &endpoint,
            &BTreeMap::<String, BigUint>::new(),
        )
        .unwrap();
        let empty_receipt =
            apply_certified_pure_idle_contract_delivery(&mut state, &empty_plan).unwrap();
        assert!(empty_receipt.consumed_by_item.is_empty());
        assert_eq!(state.canonical_sha256().unwrap(), source_hash);

        let budget = BTreeMap::from([("iron_ore".to_owned(), BigUint::from(7_u64))]);
        let plan = plan_certified_pure_idle_contract_delivery(&endpoint, &budget).unwrap();
        assert_eq!(plan.steps.len(), 1);
        assert_eq!(plan.steps[0].contract_index, 0);
        assert_eq!(plan.steps[0].requirement_index, 0);
        assert_eq!(plan.steps[0].amount, BigUint::from(7_u64));
        let receipt = apply_certified_pure_idle_contract_delivery(&mut state, &plan).unwrap();
        assert_eq!(
            receipt.consumed_by_item.get("iron_ore"),
            Some(&BigUint::from(7_u64))
        );
        assert_eq!(
            receipt.endpoint_after.accepted[0].requirements[0].delivered,
            7_u8.into()
        );
        assert_eq!(
            receipt.endpoint_after.accepted[0].status,
            PureIdleContractStatus::Accepted
        );
        assert_eq!(state.base_value()["tray"], prefills.0);
        assert_eq!(state.base_value()["planetTrays"], prefills.1);
        assert_eq!(state.base_value()["quantumLogisticsNetwork"], prefills.2);
        assert_eq!(state.parse_entity(0).unwrap(), prefills.3);
    }

    #[test]
    fn certified_contract_plan_preserves_contract_and_requirement_order() {
        let first = accepted_contract_fixture(
            2,
            "advanced",
            "accepted",
            vec![
                contract_requirement("iron_ore", 5, 0, "any", None),
                contract_requirement("copper_ingot", 4, 0, "any", None),
            ],
        );
        let second = accepted_contract_fixture(
            0,
            "single",
            "accepted",
            vec![contract_requirement("iron_ore", 10, 0, "any", None)],
        );
        let mut state =
            fixture_state_with_base(contract_fixture_base(vec![first, second], json!({})), &[]);
        let endpoint = capture_pure_idle_contract_endpoint(&state).unwrap();
        let budget = BTreeMap::from([
            ("iron_ore".to_owned(), BigUint::from(12_u64)),
            ("copper_ingot".to_owned(), BigUint::from(2_u64)),
        ]);
        let plan = plan_certified_pure_idle_contract_delivery(&endpoint, &budget).unwrap();
        assert_eq!(
            plan.steps
                .iter()
                .map(|step| (
                    step.contract_index,
                    step.requirement_index,
                    step.item_id.as_str(),
                    step.amount.clone(),
                ))
                .collect::<Vec<_>>(),
            vec![
                (0, 0, "iron_ore", 5_u8.into()),
                (0, 1, "copper_ingot", 2_u8.into()),
                (1, 0, "iron_ore", 7_u8.into()),
            ]
        );
        assert!(!plan.boundary_limited);
        let receipt = apply_certified_pure_idle_contract_delivery(&mut state, &plan).unwrap();
        assert_eq!(
            receipt.endpoint_after.accepted[0].requirements[0].delivered,
            5_u8.into()
        );
        assert_eq!(
            receipt.endpoint_after.accepted[0].requirements[1].delivered,
            2_u8.into()
        );
        assert_eq!(
            receipt.endpoint_after.accepted[1].requirements[0].delivered,
            7_u8.into()
        );
        assert_eq!(
            pure_idle_contract_consumption_between(
                &receipt.endpoint_before,
                &receipt.endpoint_after
            )
            .unwrap()
            .consumed_by_item,
            receipt.consumed_by_item
        );
    }

    #[test]
    fn fixed_contract_steps_never_redirect_same_item_material_to_an_earlier_contract() {
        let earlier = accepted_contract_fixture(
            0,
            "single",
            "accepted",
            vec![contract_requirement("iron_ore", 100, 0, "any", None)],
        );
        let later = accepted_contract_fixture(
            1,
            "combination",
            "accepted",
            vec![contract_requirement("iron_ore", 100, 20, "any", None)],
        );
        let later_id = later["id"].as_str().unwrap().to_owned();
        let mut state = fixture_state_with_base(
            contract_fixture_base(vec![earlier, later], json!({ "iron_ore": "20" })),
            &[],
        );
        let endpoint = capture_pure_idle_contract_endpoint(&state).unwrap();
        let budget = BTreeMap::from([("iron_ore".to_owned(), 7_u8.into())]);
        let aggregate = plan_certified_pure_idle_contract_delivery(&endpoint, &budget).unwrap();
        assert_eq!(aggregate.steps[0].contract_index, 0);

        let requested = vec![PureIdleContractDeliveryStep {
            contract_index: 1,
            contract_id: later_id,
            requirement_index: 0,
            item_id: "iron_ore".to_owned(),
            expected_delivered: 20_u8.into(),
            amount: 7_u8.into(),
        }];
        let plan = plan_certified_pure_idle_contract_delivery_steps(&endpoint, &budget, &requested)
            .unwrap();
        assert_eq!(plan.requested_steps.as_deref(), Some(requested.as_slice()));
        assert_eq!(plan.steps[0].contract_index, 1);
        let earlier_before =
            state.base_value()["orbitalStation"]["contractBoard"]["accepted"][0].clone();
        let receipt = apply_certified_pure_idle_contract_delivery(&mut state, &plan).unwrap();
        assert_eq!(
            state.base_value()["orbitalStation"]["contractBoard"]["accepted"][0],
            earlier_before
        );
        assert_eq!(
            receipt.endpoint_after.accepted[0].requirements[0].delivered,
            0_u8.into()
        );
        assert_eq!(
            receipt.endpoint_after.accepted[1].requirements[0].delivered,
            27_u8.into()
        );
        assert_eq!(
            pure_idle_contract_consumption_between(
                &receipt.endpoint_before,
                &receipt.endpoint_after
            )
            .unwrap()
            .requirement_deltas
            .iter()
            .map(|delta| delta.delivered.clone())
            .collect::<Vec<_>>(),
            vec![0_u8.into(), 7_u8.into()]
        );
    }

    #[test]
    fn exact_completion_budget_stops_one_unit_before_claimable_and_segments_match() {
        let make_state = || {
            fixture_state_with_base(
                contract_fixture_base(
                    vec![accepted_contract_fixture(
                        0,
                        "single",
                        "accepted",
                        vec![contract_requirement("iron_ore", 10, 0, "any", None)],
                    )],
                    json!({}),
                ),
                &[],
            )
        };
        let exact_budget = BTreeMap::from([("iron_ore".to_owned(), 10_u8.into())]);
        let mut long = make_state();
        let long_endpoint = capture_pure_idle_contract_endpoint(&long).unwrap();
        let long_plan =
            plan_certified_pure_idle_contract_delivery(&long_endpoint, &exact_budget).unwrap();
        assert!(long_plan.boundary_limited);
        assert_eq!(long_plan.steps[0].amount, 9_u8.into());
        assert_eq!(
            long_plan.boundary.as_ref().unwrap().reserved_units,
            1_u8.into()
        );
        let long_receipt =
            apply_certified_pure_idle_contract_delivery(&mut long, &long_plan).unwrap();
        assert_eq!(
            long_receipt.endpoint_after.accepted[0].status,
            PureIdleContractStatus::Accepted
        );
        assert_eq!(
            long_receipt.endpoint_after.accepted[0].requirements[0].delivered,
            9_u8.into()
        );

        let mut segmented = make_state();
        let first_endpoint = capture_pure_idle_contract_endpoint(&segmented).unwrap();
        let first_plan = plan_certified_pure_idle_contract_delivery(
            &first_endpoint,
            &BTreeMap::from([("iron_ore".to_owned(), 4_u8.into())]),
        )
        .unwrap();
        assert!(!first_plan.boundary_limited);
        apply_certified_pure_idle_contract_delivery(&mut segmented, &first_plan).unwrap();
        let second_endpoint = capture_pure_idle_contract_endpoint(&segmented).unwrap();
        let second_plan = plan_certified_pure_idle_contract_delivery(
            &second_endpoint,
            &BTreeMap::from([("iron_ore".to_owned(), 6_u8.into())]),
        )
        .unwrap();
        assert!(second_plan.boundary_limited);
        assert_eq!(second_plan.steps[0].amount, 5_u8.into());
        let segmented_receipt =
            apply_certified_pure_idle_contract_delivery(&mut segmented, &second_plan).unwrap();
        assert_eq!(
            segmented_receipt.endpoint_after,
            long_receipt.endpoint_after
        );

        let one_short_hash = segmented.canonical_sha256().unwrap();
        let one_short_endpoint = capture_pure_idle_contract_endpoint(&segmented).unwrap();
        let one_short_plan = plan_certified_pure_idle_contract_delivery(
            &one_short_endpoint,
            &BTreeMap::from([("iron_ore".to_owned(), 1_u8.into())]),
        )
        .unwrap();
        assert!(one_short_plan.steps.is_empty());
        assert!(one_short_plan.boundary_limited);
        apply_certified_pure_idle_contract_delivery(&mut segmented, &one_short_plan).unwrap();
        assert_eq!(segmented.canonical_sha256().unwrap(), one_short_hash);
    }

    #[test]
    fn first_claimable_boundary_skips_already_claimable_rows_in_persisted_order() {
        let completed = accepted_contract_fixture(
            0,
            "single",
            "claimable",
            vec![contract_requirement("iron_ore", 10, 10, "any", None)],
        );
        let active = accepted_contract_fixture(
            1,
            "combination",
            "accepted",
            vec![contract_requirement("copper_ingot", 5, 1, "any", None)],
        );
        let active_id = active["id"].as_str().unwrap().to_owned();
        let state = fixture_state_with_base(
            contract_fixture_base(vec![completed, active], json!({ "iron_ore": "10" })),
            &[],
        );
        let endpoint = capture_pure_idle_contract_endpoint(&state).unwrap();
        let boundary = endpoint.first_claimable_boundary.unwrap();
        assert_eq!(boundary.contract_index, 1);
        assert_eq!(boundary.contract_id, active_id);
        assert_eq!(boundary.remaining_total, 4_u8.into());
        assert_eq!(
            boundary.remaining_by_item.get("copper_ingot"),
            Some(&BigUint::from(4_u8))
        );
    }

    #[test]
    fn certified_contract_delivery_clips_at_the_export_counter_capacity() {
        let maximum = maximum_station_integer();
        let current = &maximum - 2_u8;
        let contract = accepted_contract_fixture(
            0,
            "single",
            "accepted",
            vec![contract_requirement("iron_ore", 100, 0, "any", None)],
        );
        let mut state = fixture_state_with_base(
            contract_fixture_base(vec![contract], json!({ "iron_ore": current.to_string() })),
            &[],
        );
        let endpoint = capture_pure_idle_contract_endpoint(&state).unwrap();
        let plan = plan_certified_pure_idle_contract_delivery(
            &endpoint,
            &BTreeMap::from([("iron_ore".to_owned(), 5_u8.into())]),
        )
        .unwrap();
        assert_eq!(plan.steps[0].amount, 2_u8.into());
        assert_eq!(
            plan.export_limited_by_item.get("iron_ore"),
            Some(&BigUint::from(3_u8))
        );
        let receipt = apply_certified_pure_idle_contract_delivery(&mut state, &plan).unwrap();
        assert_eq!(
            receipt.endpoint_after.exported_by_item.get("iron_ore"),
            Some(&maximum)
        );
        assert_eq!(
            receipt.endpoint_after.accepted[0].requirements[0].delivered,
            2_u8.into()
        );
    }

    #[test]
    fn source_restrictions_and_uncertain_rewards_fail_closed_atomically() {
        let restricted = accepted_contract_fixture(
            0,
            "origin",
            "accepted",
            vec![contract_requirement(
                "iron_ore",
                10,
                0,
                "terminal",
                Some(vec!["home"]),
            )],
        );
        let state =
            fixture_state_with_base(contract_fixture_base(vec![restricted], json!({})), &[]);
        let hash = state.canonical_sha256().unwrap();
        let endpoint = capture_pure_idle_contract_endpoint(&state).unwrap();
        let error = plan_certified_pure_idle_contract_delivery(
            &endpoint,
            &BTreeMap::from([("iron_ore".to_owned(), 10_u8.into())]),
        )
        .unwrap_err();
        assert!(error.to_string().contains("source planet"));
        assert_eq!(state.canonical_sha256().unwrap(), hash);

        let mut invalid = accepted_contract_fixture(
            0,
            "single",
            "accepted",
            vec![contract_requirement("iron_ore", 10, 0, "any", None)],
        );
        invalid["rewards"]["completionMarks"] = json!("999");
        let invalid_state =
            fixture_state_with_base(contract_fixture_base(vec![invalid], json!({})), &[]);
        let invalid_hash = invalid_state.canonical_sha256().unwrap();
        let error = capture_pure_idle_contract_endpoint(&invalid_state).unwrap_err();
        assert!(error.to_string().contains("rewards"));
        assert_eq!(invalid_state.canonical_sha256().unwrap(), invalid_hash);
    }

    #[test]
    fn stale_or_forged_contract_plan_never_partially_commits() {
        let contract = accepted_contract_fixture(
            0,
            "single",
            "accepted",
            vec![contract_requirement("iron_ore", 10, 0, "any", None)],
        );
        let mut state =
            fixture_state_with_base(contract_fixture_base(vec![contract], json!({})), &[]);
        let endpoint = capture_pure_idle_contract_endpoint(&state).unwrap();
        let plan = plan_certified_pure_idle_contract_delivery(
            &endpoint,
            &BTreeMap::from([("iron_ore".to_owned(), 3_u8.into())]),
        )
        .unwrap();
        state.base_value_mut()["orbitalStation"]["contractBoard"]["lastConfirmedWallClockMs"] =
            json!(8_640_000_001_u64);
        let stale_hash = state.canonical_sha256().unwrap();
        let error = apply_certified_pure_idle_contract_delivery(&mut state, &plan).unwrap_err();
        assert!(error.to_string().contains("diverged"));
        assert_eq!(state.canonical_sha256().unwrap(), stale_hash);

        let fresh_endpoint = capture_pure_idle_contract_endpoint(&state).unwrap();
        let mut forged = plan_certified_pure_idle_contract_delivery(
            &fresh_endpoint,
            &BTreeMap::from([("iron_ore".to_owned(), 3_u8.into())]),
        )
        .unwrap();
        forged.steps[0].amount += 1_u8;
        let forged_hash = state.canonical_sha256().unwrap();
        let error = apply_certified_pure_idle_contract_delivery(&mut state, &forged).unwrap_err();
        assert!(error.to_string().contains("not canonical"));
        assert_eq!(state.canonical_sha256().unwrap(), forged_hash);
    }

    #[test]
    fn interval_receipt_rejects_unbacked_requirement_or_export_growth() {
        let contract = accepted_contract_fixture(
            0,
            "single",
            "accepted",
            vec![contract_requirement("iron_ore", 10, 0, "any", None)],
        );
        let mut state =
            fixture_state_with_base(contract_fixture_base(vec![contract], json!({})), &[]);
        let before = capture_pure_idle_contract_endpoint(&state).unwrap();
        let plan = plan_certified_pure_idle_contract_delivery(
            &before,
            &BTreeMap::from([("iron_ore".to_owned(), 3_u8.into())]),
        )
        .unwrap();
        let receipt = apply_certified_pure_idle_contract_delivery(&mut state, &plan).unwrap();
        let interval =
            pure_idle_contract_consumption_between(&before, &receipt.endpoint_after).unwrap();
        assert_eq!(
            interval.consumed_by_item.get("iron_ore"),
            Some(&3_u8.into())
        );

        let mut forged_export = receipt.endpoint_after.clone();
        *forged_export
            .exported_by_item
            .entry("iron_ore".to_owned())
            .or_default() += 1_u8;
        assert!(pure_idle_contract_consumption_between(&before, &forged_export).is_err());

        let mut forged_requirement = receipt.endpoint_after;
        forged_requirement.accepted[0].requirements[0].delivered += 1_u8;
        assert!(pure_idle_contract_consumption_between(&before, &forged_requirement).is_err());
    }
}
