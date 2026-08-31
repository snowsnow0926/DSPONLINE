//! Bounded Rust-authoritative contract-board projection and player intents.
//!
//! The renderer may name one contract/item and, for quantum delivery, one
//! desired decimal amount. It never supplies a GameState patch, inventory
//! balance, progress delta, settlement amount, or reward. The CORE proves the
//! exact session/run/revision/registry lineage, re-derives every debit and
//! reward from the current v47 state, and expands the intent into the ordinary
//! durable command patch consumed by the Host WAL/checkpoint transaction.

use std::collections::HashSet;

use anyhow::{anyhow, bail};
use num_bigint::BigUint;
use num_traits::{ToPrimitive, Zero};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::command::{
    EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT, PathSegment, SimulationCommandPatch, ValuePatch,
};
use crate::{CORE_PROTOCOL_VERSION, CommandApplyResult, CoreState};

pub const ORBITAL_CONTRACT_WORKSPACE_PROJECTION: &str = "orbital-contract-workspace-v1";
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_TEXT_BYTES: usize = 512;
const MAX_DECIMAL_DIGITS: usize = 256;
const MAX_PROJECTION_BYTES: usize = 256 * 1024;
const MAX_OFFERS: usize = 4;
const MAX_ACCEPTED: usize = 3;
const MAX_HISTORY: usize = 48;
const MAX_PROJECTED_HISTORY: usize = 8;
const MAX_REQUIREMENTS: usize = 6;
const MAX_SETTLED_IDS: usize = 4_096;
const RULES_VERSION: u64 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrbitalContractAuthority {
    pub session_id: String,
    pub run_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum OrbitalContractIntent {
    Accept {
        contract_id: String,
    },
    DeliverQuantum {
        contract_id: String,
        item_id: String,
        requested_amount: String,
    },
    Claim {
        contract_id: String,
    },
    Abandon {
        contract_id: String,
    },
    Feature {
        contract_id: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OrbitalContractCommandRequest {
    pub command_id: String,
    pub session_id: String,
    pub run_id: String,
    pub expected_revision: u64,
    pub expected_registry_fingerprint: String,
    pub confirmed_wall_clock_ms: u64,
    pub intent: OrbitalContractIntent,
}

#[derive(Debug, Clone)]
pub struct PreparedOrbitalContractCommand {
    request: OrbitalContractCommandRequest,
    base_sha256: String,
    semantic_sha256: String,
    patch_sha256: String,
    patch: SimulationCommandPatch,
}

impl PreparedOrbitalContractCommand {
    pub fn patch(&self) -> &SimulationCommandPatch {
        &self.patch
    }

    pub fn command_id(&self) -> &str {
        &self.request.command_id
    }

    pub fn expected_revision(&self) -> u64 {
        self.request.expected_revision
    }

    pub fn apply(
        &self,
        state: &mut CoreState,
        authority: &OrbitalContractAuthority,
    ) -> anyhow::Result<CommandApplyResult> {
        let current = prepare_orbital_contract_command(state, authority, self.request.clone())?;
        if current.base_sha256 != self.base_sha256
            || current.semantic_sha256 != self.semantic_sha256
            || current.patch_sha256 != self.patch_sha256
        {
            bail!("native orbital-contract command changed after prepare")
        }
        state.apply_command(&self.patch)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SemanticRequest<'a> {
    session_id: &'a str,
    run_id: &'a str,
    expected_revision: u64,
    expected_registry_fingerprint: &'a str,
    confirmed_wall_clock_ms: u64,
    intent: &'a OrbitalContractIntent,
}

pub fn orbital_contract_semantic_sha256(
    request: &OrbitalContractCommandRequest,
) -> anyhow::Result<String> {
    validate_text("command ID", &request.command_id)?;
    validate_text("session ID", &request.session_id)?;
    validate_text("run ID", &request.run_id)?;
    validate_text(
        "registry fingerprint",
        &request.expected_registry_fingerprint,
    )?;
    if request.expected_revision >= MAX_SAFE_INTEGER {
        bail!("native orbital-contract command revision is exhausted")
    }
    if request.confirmed_wall_clock_ms > MAX_SAFE_INTEGER {
        bail!("native orbital-contract confirmed wall clock is invalid")
    }
    validate_intent(&request.intent)?;
    sha256_json(&SemanticRequest {
        session_id: &request.session_id,
        run_id: &request.run_id,
        expected_revision: request.expected_revision,
        expected_registry_fingerprint: &request.expected_registry_fingerprint,
        confirmed_wall_clock_ms: request.confirmed_wall_clock_ms,
        intent: &request.intent,
    })
}

pub fn derive_orbital_contract_command_id(
    request: &OrbitalContractCommandRequest,
) -> anyhow::Result<String> {
    Ok(format!(
        "orbital-contract-v1-{}",
        orbital_contract_semantic_sha256(request)?
    ))
}

pub fn prepare_orbital_contract_command(
    state: &CoreState,
    authority: &OrbitalContractAuthority,
    request: OrbitalContractCommandRequest,
) -> anyhow::Result<PreparedOrbitalContractCommand> {
    validate_text("current session ID", &authority.session_id)?;
    validate_text("current run ID", &authority.run_id)?;
    if request.session_id != authority.session_id {
        bail!("native orbital-contract command session is stale")
    }
    if request.run_id != authority.run_id {
        bail!("native orbital-contract command run is stale")
    }
    if request.expected_revision != state.revision || request.expected_revision >= MAX_SAFE_INTEGER
    {
        bail!("native orbital-contract command revision is stale")
    }
    if request.expected_registry_fingerprint != state.identity.registry_fingerprint
        || request.expected_registry_fingerprint != state.catalog.snapshot.registry_fingerprint
    {
        bail!("native orbital-contract command registry is stale")
    }
    if request.expected_registry_fingerprint != EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT {
        bail!("native orbital-contract command registry is outside the built-in domain")
    }
    require_contract_domain(state)?;
    let semantic_sha256 = orbital_contract_semantic_sha256(&request)?;
    let patch = build_patch(state, request.confirmed_wall_clock_ms, &request.intent)?;
    let patch_sha256 = sha256_json(&patch)?;
    Ok(PreparedOrbitalContractCommand {
        request,
        base_sha256: state.canonical_sha256()?,
        semantic_sha256,
        patch_sha256,
        patch,
    })
}

impl CoreState {
    pub fn orbital_contract_workspace_projection(
        &self,
        session_id: &str,
        run_id: &str,
        expected_revision: u64,
        expected_registry_fingerprint: &str,
        confirmed_wall_clock_ms: u64,
    ) -> anyhow::Result<Value> {
        validate_text("projection session ID", session_id)?;
        validate_text("projection run ID", run_id)?;
        validate_text(
            "projection registry fingerprint",
            expected_registry_fingerprint,
        )?;
        if expected_revision != self.revision
            || confirmed_wall_clock_ms > MAX_SAFE_INTEGER
            || expected_registry_fingerprint != self.identity.registry_fingerprint
            || expected_registry_fingerprint != self.catalog.snapshot.registry_fingerprint
        {
            bail!("native orbital-contract projection identity is stale")
        }
        require_contract_domain(self)?;
        let mut synchronized_base = self.base_value().clone();
        crate::station_contracts::synchronize_with_confirmed_wall_clock(
            self,
            &mut synchronized_base,
            confirmed_wall_clock_ms,
        )?;
        let base = &synchronized_base;
        let station = station(base)?;
        let board = validated_board(self, base)?;
        let quantum = base
            .get("quantumLogisticsNetwork")
            .and_then(Value::as_object)
            .ok_or_else(|| anyhow!("native orbital-contract quantum network is missing"))?;
        let enabled = quantum
            .get("enabled")
            .and_then(Value::as_bool)
            .ok_or_else(|| anyhow!("native orbital-contract quantum enabled flag is invalid"))?;
        let inventory = quantum
            .get("inventory")
            .and_then(Value::as_object)
            .ok_or_else(|| anyhow!("native orbital-contract quantum inventory is invalid"))?;

        let offers = board
            .get("offers")
            .and_then(Value::as_array)
            .expect("validated offers")
            .iter()
            .map(|contract| project_contract(self, base, contract, inventory, false))
            .collect::<anyhow::Result<Vec<_>>>()?;
        let accepted = board
            .get("accepted")
            .and_then(Value::as_array)
            .expect("validated accepted")
            .iter()
            .map(|contract| project_contract(self, base, contract, inventory, true))
            .collect::<anyhow::Result<Vec<_>>>()?;
        let history = board
            .get("history")
            .and_then(Value::as_array)
            .expect("validated history");
        let featured_contract_id = board.get("featuredContractId").and_then(Value::as_str);
        let completed = history
            .iter()
            .filter(|contract| {
                contract.get("settlementReason").and_then(Value::as_str) == Some("completed")
            })
            .collect::<Vec<_>>();
        let featured_in_newest = featured_contract_id.is_some_and(|featured| {
            completed
                .iter()
                .take(MAX_PROJECTED_HISTORY)
                .any(|contract| contract.get("id").and_then(Value::as_str) == Some(featured))
        });
        let newest_limit = if featured_contract_id.is_some() && !featured_in_newest {
            MAX_PROJECTED_HISTORY - 1
        } else {
            MAX_PROJECTED_HISTORY
        };
        let mut completed_history = completed
            .iter()
            .take(newest_limit)
            .map(|contract| project_history_contract(contract))
            .collect::<anyhow::Result<Vec<_>>>()?;
        if let Some(featured) = featured_contract_id.filter(|_| !featured_in_newest) {
            let contract = completed
                .iter()
                .find(|contract| contract.get("id").and_then(Value::as_str) == Some(featured))
                .expect("validated featured completed contract");
            completed_history.push(project_history_contract(contract)?);
        }
        let economy = station
            .get("economy")
            .and_then(Value::as_object)
            .ok_or_else(|| anyhow!("native orbital-contract economy is invalid"))?;
        let totals = station
            .get("totals")
            .and_then(Value::as_object)
            .ok_or_else(|| anyhow!("native orbital-contract totals are invalid"))?;
        let projection = json!({
            "schemaVersion": 1,
            "projectionType": ORBITAL_CONTRACT_WORKSPACE_PROJECTION,
            "source": "native-core",
            "sessionId": session_id,
            "runId": run_id,
            "revision": self.revision,
            "registryFingerprint": self.identity.registry_fingerprint,
            "stateVersion": self.identity.state_version,
            "stationStatus": station.get("status").cloned().unwrap_or(Value::Null),
            "taskDay": board.get("taskDay").cloned().unwrap_or(Value::Null),
            "rulesVersion": RULES_VERSION,
            "quantumEnabled": enabled,
            "orbitalMarks": decimal_text(economy.get("orbitalMarks"), "orbital marks")?,
            "stationReputation": decimal_text(economy.get("stationReputation"), "station reputation")?,
            "completedContracts": safe_u64(totals.get("completedContracts"), "completed contracts")?,
            "featuredContractId": board.get("featuredContractId").cloned().unwrap_or(Value::Null),
            "offers": offers,
            "accepted": accepted,
            "completedHistory": completed_history,
            "limits": {
                "offerCount": MAX_OFFERS,
                "acceptedCount": MAX_ACCEPTED,
                "historyCount": MAX_PROJECTED_HISTORY,
                "requirementsPerContract": MAX_REQUIREMENTS,
                "projectionBytes": MAX_PROJECTION_BYTES,
            },
            "unsupported": ["cargo-terminal-binding", "decorations", "profile", "construction"],
        });
        if serde_json::to_vec(&projection)?.len() > MAX_PROJECTION_BYTES {
            bail!("native orbital-contract projection exceeds its bounded byte limit")
        }
        Ok(projection)
    }
}

fn project_contract(
    state: &CoreState,
    base: &Map<String, Value>,
    value: &Value,
    inventory: &Map<String, Value>,
    include_progress: bool,
) -> anyhow::Result<Value> {
    let contract = value
        .as_object()
        .ok_or_else(|| anyhow!("native orbital-contract row is invalid"))?;
    validate_contract(state, base, contract, include_progress, false)?;
    let requirements = contract
        .get("requirements")
        .and_then(Value::as_array)
        .expect("validated requirements")
        .iter()
        .map(|entry| {
            let row = entry.as_object().expect("validated requirement");
            let item_id = row.get("itemId").and_then(Value::as_str).expect("validated item");
            Ok(json!({
                "itemId": item_id,
                "amount": decimal_text(row.get("amount"), "requirement amount")?,
                "delivered": decimal_text(row.get("delivered"), "requirement delivered")?,
                "channel": row.get("channel").cloned().unwrap_or(Value::Null),
                "sourcePlanetIds": row.get("sourcePlanetIds").cloned().unwrap_or_else(|| Value::Array(Vec::new())),
                "availableQuantum": decimal_text(inventory.get(item_id), "quantum item inventory")?,
            }))
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    let rewards = deterministic_rewards(contract)?;
    Ok(json!({
        "id": contract.get("id").cloned().unwrap_or(Value::Null),
        "templateId": contract.get("templateId").cloned().unwrap_or(Value::Null),
        "slot": contract.get("slot").cloned().unwrap_or(Value::Null),
        "title": contract.get("title").cloned().unwrap_or(Value::Null),
        "summary": contract.get("summary").cloned().unwrap_or(Value::Null),
        "taskDay": contract.get("taskDay").cloned().unwrap_or(Value::Null),
        "expiresAtTaskDay": contract.get("expiresAtTaskDay").cloned().unwrap_or(Value::Null),
        "special": contract.get("special").cloned().unwrap_or(Value::Null),
        "difficulty": contract.get("difficulty").cloned().unwrap_or(Value::Null),
        "status": contract.get("status").cloned().unwrap_or(Value::Null),
        "requirements": requirements,
        "rewardMarks": (&rewards.base_marks + &rewards.completion_marks).to_string(),
        "rewardReputation": (&rewards.base_reputation + &rewards.completion_reputation).to_string(),
        "completionBasisPoints": completion_basis_points(contract)?,
    }))
}

fn project_history_contract(value: &Value) -> anyhow::Result<Value> {
    let contract = value
        .as_object()
        .ok_or_else(|| anyhow!("native orbital-contract history row is invalid"))?;
    Ok(json!({
        "id": required_str(contract, "id")?,
        "title": required_str(contract, "title")?,
        "difficulty": required_str(contract, "difficulty")?,
        "settledAtTaskDay": safe_u64(contract.get("settledAtTaskDay"), "settled task day")?,
    }))
}

fn require_contract_domain(state: &CoreState) -> anyhow::Result<()> {
    if state.identity.state_version != 47
        || state.base_value().get("version").and_then(Value::as_u64) != Some(47)
        || state.base_value().get("mode").and_then(Value::as_str) != Some("normal")
    {
        bail!("native orbital-contract authority requires normal GameState v47")
    }
    match state.base_value().get("contentPacks") {
        Some(Value::Array(packs)) if packs.is_empty() => {}
        _ => bail!("native orbital-contract authority does not support content packs"),
    }
    validated_board(state, state.base_value())?;
    Ok(())
}

fn station(base: &Map<String, Value>) -> anyhow::Result<&Map<String, Value>> {
    let station = base
        .get("orbitalStation")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native orbital-contract station is missing"))?;
    if !matches!(
        station.get("status").and_then(Value::as_str),
        Some("showcase-building" | "operational")
    ) {
        bail!("native orbital-contract board is not unlocked")
    }
    Ok(station)
}

fn validated_board<'a>(
    state: &CoreState,
    base: &'a Map<String, Value>,
) -> anyhow::Result<&'a Map<String, Value>> {
    let station = station(base)?;
    let board = station
        .get("contractBoard")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native orbital-contract board is invalid"))?;
    if safe_u64(board.get("rulesVersion"), "rules version")? != RULES_VERSION {
        bail!("native orbital-contract rules version is unsupported")
    }
    let task_day = safe_u64(board.get("taskDay"), "task day")?;
    safe_u64(
        board.get("lastConfirmedWallClockMs"),
        "confirmed wall clock",
    )?;
    let offers = bounded_array(board.get("offers"), MAX_OFFERS, "offers")?;
    let accepted = bounded_array(board.get("accepted"), MAX_ACCEPTED, "accepted")?;
    let history = bounded_array(board.get("history"), MAX_HISTORY, "history")?;
    let settled = bounded_array(board.get("settledIds"), MAX_SETTLED_IDS, "settled IDs")?;
    let mut active_ids = HashSet::new();
    for value in offers {
        let contract = value
            .as_object()
            .ok_or_else(|| anyhow!("native orbital-contract offer is invalid"))?;
        validate_contract(state, base, contract, false, false)?;
        if required_str(contract, "status")? != "offered"
            || safe_u64(contract.get("taskDay"), "offer task day")? != task_day
            || !active_ids.insert(required_str(contract, "id")?.to_owned())
        {
            bail!("native orbital-contract offer identity is invalid")
        }
    }
    for value in accepted {
        let contract = value
            .as_object()
            .ok_or_else(|| anyhow!("native orbital-contract accepted row is invalid"))?;
        validate_contract(state, base, contract, true, false)?;
        let status = required_str(contract, "status")?;
        let contract_day = safe_u64(contract.get("taskDay"), "contract task day")?;
        let expires = safe_u64(contract.get("expiresAtTaskDay"), "contract expiry")?;
        if !matches!(status, "accepted" | "claimable")
            || contract_day > task_day
            || expires <= task_day
            || !active_ids.insert(required_str(contract, "id")?.to_owned())
        {
            bail!("native orbital-contract accepted identity is invalid")
        }
        let complete = completion_basis_points(contract)? == 10_000;
        if (status == "claimable") != complete {
            bail!("native orbital-contract claimable status is invalid")
        }
    }
    let mut history_ids = HashSet::new();
    for value in history {
        let contract = value
            .as_object()
            .ok_or_else(|| anyhow!("native orbital-contract history row is invalid"))?;
        validate_contract(state, base, contract, true, true)?;
        if required_str(contract, "status")? != "settled"
            || !history_ids.insert(required_str(contract, "id")?.to_owned())
        {
            bail!("native orbital-contract history identity is invalid")
        }
    }
    let mut settled_ids = HashSet::new();
    for value in settled {
        let id = value
            .as_str()
            .ok_or_else(|| anyhow!("native orbital-contract settlement fence is invalid"))?;
        validate_text("settled contract ID", id)?;
        if !settled_ids.insert(id.to_owned()) {
            bail!("native orbital-contract settlement fence is duplicated")
        }
    }
    if history_ids.iter().any(|id| !settled_ids.contains(id))
        || active_ids.iter().any(|id| settled_ids.contains(id))
    {
        bail!("native orbital-contract settlement fence conflicts")
    }
    match board.get("featuredContractId") {
        None | Some(Value::Null) => {}
        Some(Value::String(id)) => {
            validate_text("featured contract ID", id)?;
            let valid = history.iter().any(|value| {
                value.get("id").and_then(Value::as_str) == Some(id)
                    && value.get("settlementReason").and_then(Value::as_str) == Some("completed")
            });
            if !valid {
                bail!("native orbital-contract featured contract is invalid")
            }
        }
        _ => bail!("native orbital-contract featured contract is invalid"),
    }
    validate_station_ledgers(state, station)?;
    Ok(board)
}

fn validate_station_ledgers(state: &CoreState, station: &Map<String, Value>) -> anyhow::Result<()> {
    let economy = station
        .get("economy")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native orbital-contract economy is invalid"))?;
    decimal(economy.get("orbitalMarks"), "orbital marks")?;
    decimal(economy.get("stationReputation"), "station reputation")?;
    let totals = station
        .get("totals")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native orbital-contract totals are invalid"))?;
    safe_u64(totals.get("completedContracts"), "completed contracts")?;
    let exported = totals
        .get("exportedByItem")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native orbital-contract export totals are invalid"))?;
    for (item_id, amount) in exported {
        ensure_item(state, item_id)?;
        decimal(Some(amount), "export total")?;
    }
    Ok(())
}

fn validate_contract(
    state: &CoreState,
    base: &Map<String, Value>,
    contract: &Map<String, Value>,
    progress_allowed: bool,
    settled: bool,
) -> anyhow::Result<()> {
    let id = required_str(contract, "id")?;
    let template = required_str(contract, "templateId")?;
    let slot = safe_u64(contract.get("slot"), "contract slot")?;
    let task_day = safe_u64(contract.get("taskDay"), "contract task day")?;
    let expires = safe_u64(contract.get("expiresAtTaskDay"), "contract expiry")?;
    let special = contract
        .get("special")
        .and_then(Value::as_bool)
        .ok_or_else(|| anyhow!("native orbital-contract special flag is invalid"))?;
    if slot > 3 || special != (slot == 3) || expires != task_day.saturating_add(3) {
        bail!("native orbital-contract day/slot identity is invalid")
    }
    for field in ["title", "summary"] {
        validate_text(field, required_str(contract, field)?)?;
    }
    if !matches!(
        template,
        "single" | "combination" | "dyson" | "origin" | "multi-origin" | "quantum" | "advanced"
    ) {
        bail!("native orbital-contract template is invalid")
    }
    let seed = base
        .get("galaxy")
        .and_then(Value::as_object)
        .and_then(|galaxy| galaxy.get("seed"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let expected_id =
        format!("station-contract-v{RULES_VERSION}-{seed}-{task_day}-{slot}-{template}");
    if id != expected_id {
        bail!("native orbital-contract deterministic ID is invalid")
    }
    let requirements = bounded_array(
        contract.get("requirements"),
        MAX_REQUIREMENTS,
        "requirements",
    )?;
    if requirements.is_empty() {
        bail!("native orbital-contract requirements are empty")
    }
    for value in requirements {
        let row = value
            .as_object()
            .ok_or_else(|| anyhow!("native orbital-contract requirement is invalid"))?;
        let item_id = required_str(row, "itemId")?;
        ensure_item(state, item_id)?;
        let amount = decimal(row.get("amount"), "requirement amount")?;
        let delivered = decimal(row.get("delivered"), "requirement delivered")?;
        if amount.is_zero() || delivered > amount || !progress_allowed && !delivered.is_zero() {
            bail!("native orbital-contract requirement progress is invalid")
        }
        if !matches!(
            required_str(row, "channel")?,
            "any" | "terminal" | "quantum"
        ) {
            bail!("native orbital-contract requirement channel is invalid")
        }
        let weight = safe_u64(row.get("weight"), "requirement weight")?;
        if !(1..=10_000).contains(&weight) {
            bail!("native orbital-contract requirement weight is invalid")
        }
        if let Some(source) = row.get("sourcePlanetIds") {
            let source = bounded_array(Some(source), 4, "source planets")?;
            let mut seen = HashSet::new();
            for planet in source {
                let planet = planet
                    .as_str()
                    .ok_or_else(|| anyhow!("native orbital-contract source planet is invalid"))?;
                if !seen.insert(planet)
                    || !state
                        .catalog
                        .planets
                        .iter()
                        .any(|candidate| candidate.id == planet)
                {
                    bail!("native orbital-contract source planet is invalid")
                }
            }
        }
    }
    let expected_rewards = deterministic_rewards(contract)?;
    let rewards = contract
        .get("rewards")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native orbital-contract rewards are invalid"))?;
    for (key, expected) in [
        ("baseMarks", &expected_rewards.base_marks),
        ("baseReputation", &expected_rewards.base_reputation),
        ("completionMarks", &expected_rewards.completion_marks),
        (
            "completionReputation",
            &expected_rewards.completion_reputation,
        ),
    ] {
        if decimal(rewards.get(key), "contract reward")? != *expected {
            bail!("native orbital-contract persisted reward is not deterministic")
        }
    }
    if settled {
        let reason = required_str(contract, "settlementReason")?;
        if !matches!(reason, "completed" | "abandoned" | "expired") {
            bail!("native orbital-contract settlement reason is invalid")
        }
        let expected_settlement = format!("station-settlement:{id}:{reason}");
        if required_str(contract, "settlementId")? != expected_settlement {
            bail!("native orbital-contract settlement ID is invalid")
        }
        safe_u64(contract.get("settledAtTaskDay"), "settled task day")?;
        let basis = safe_u64(
            contract.get("completionBasisPoints"),
            "completion basis points",
        )?;
        if basis != completion_basis_points(contract)? || basis > 10_000 {
            bail!("native orbital-contract settlement basis is invalid")
        }
        if (reason == "completed") != (basis == 10_000) {
            bail!("native orbital-contract completed settlement is invalid")
        }
    } else if contract
        .get("settlementId")
        .is_some_and(|value| !value.is_null())
    {
        bail!("native orbital-contract active row is already settled")
    }
    Ok(())
}

#[derive(Debug)]
struct Rewards {
    base_marks: BigUint,
    base_reputation: BigUint,
    completion_marks: BigUint,
    completion_reputation: BigUint,
}

fn deterministic_rewards(contract: &Map<String, Value>) -> anyhow::Result<Rewards> {
    let difficulty = required_str(contract, "difficulty")?;
    let (marks, reputation, completion_marks, completion_reputation) = match difficulty {
        "P1" => (45_u64, 30_u64, 20_u64, 15_u64),
        "P2" => (120, 80, 65, 40),
        "P3" => (300, 200, 180, 120),
        _ => bail!("native orbital-contract difficulty is invalid"),
    };
    let special = contract
        .get("special")
        .and_then(Value::as_bool)
        .ok_or_else(|| anyhow!("native orbital-contract special flag is invalid"))?;
    let multiplier = if special { 2_u64 } else { 1_u64 };
    Ok(Rewards {
        base_marks: BigUint::from(marks * multiplier),
        base_reputation: BigUint::from(reputation * multiplier),
        completion_marks: BigUint::from(completion_marks * multiplier),
        completion_reputation: BigUint::from(completion_reputation * multiplier),
    })
}

fn build_patch(
    state: &CoreState,
    confirmed_wall_clock_ms: u64,
    intent: &OrbitalContractIntent,
) -> anyhow::Result<SimulationCommandPatch> {
    let mut synchronized_base = state.base_value().clone();
    validated_board(state, &synchronized_base)?;
    crate::station_contracts::synchronize_with_confirmed_wall_clock(
        state,
        &mut synchronized_base,
        confirmed_wall_clock_ms,
    )?;
    validated_board(state, &synchronized_base)?;
    let base = &synchronized_base;
    let mut orbital = base
        .get("orbitalStation")
        .cloned()
        .ok_or_else(|| anyhow!("native orbital-contract station is missing"))?;
    let station = orbital
        .as_object_mut()
        .ok_or_else(|| anyhow!("native orbital-contract station is invalid"))?;
    let mut network_change = None;
    match intent {
        OrbitalContractIntent::Accept { contract_id } => {
            accept_contract(state, base, station, contract_id)?;
        }
        OrbitalContractIntent::DeliverQuantum {
            contract_id,
            item_id,
            requested_amount,
        } => {
            network_change = Some(deliver_quantum(
                state,
                base,
                station,
                contract_id,
                item_id,
                requested_amount,
            )?);
        }
        OrbitalContractIntent::Claim { contract_id } => {
            settle_active_contract(station, contract_id, true)?;
        }
        OrbitalContractIntent::Abandon { contract_id } => {
            settle_active_contract(station, contract_id, false)?;
        }
        OrbitalContractIntent::Feature { contract_id } => {
            feature_contract(station, contract_id.as_deref())?;
        }
    }
    let mut candidate_base = synchronized_base.clone();
    candidate_base.insert("orbitalStation".to_owned(), orbital.clone());
    if let Some((item_id, amount)) = network_change.as_ref() {
        candidate_base
            .get_mut("quantumLogisticsNetwork")
            .and_then(Value::as_object_mut)
            .and_then(|network| network.get_mut("inventory"))
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native orbital-contract quantum inventory disappeared"))?
            .insert(item_id.clone(), Value::String(amount.to_string()));
    }
    validated_board(state, &candidate_base)?;
    let mut patch = empty_patch(state);
    patch
        .top_level_changes
        .push(set_top(&["orbitalStation"], orbital));
    if let Some((item_id, amount)) = network_change {
        patch.top_level_changes.push(set_top(
            &["quantumLogisticsNetwork", "inventory", &item_id],
            Value::String(amount.to_string()),
        ));
    }
    Ok(patch)
}

fn accept_contract(
    state: &CoreState,
    base: &Map<String, Value>,
    station: &mut Map<String, Value>,
    contract_id: &str,
) -> anyhow::Result<()> {
    validate_text("contract ID", contract_id)?;
    let board = station
        .get_mut("contractBoard")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native orbital-contract board disappeared"))?;
    let accepted_len = board
        .get("accepted")
        .and_then(Value::as_array)
        .expect("validated accepted")
        .len();
    if accepted_len >= MAX_ACCEPTED {
        bail!("native orbital-contract accept limit is reached")
    }
    let offer_index = board
        .get("offers")
        .and_then(Value::as_array)
        .expect("validated offers")
        .iter()
        .position(|value| value.get("id").and_then(Value::as_str) == Some(contract_id))
        .ok_or_else(|| anyhow!("native orbital-contract offer is missing"))?;
    let offer = board
        .get("offers")
        .and_then(Value::as_array)
        .and_then(|offers| offers.get(offer_index))
        .cloned()
        .expect("offer index exists");
    let offer_object = offer.as_object().expect("validated offer");
    let task_day = safe_u64(board.get("taskDay"), "task day")?;
    let slot = safe_u64(offer_object.get("slot"), "offer slot")? as usize;
    let generated = crate::station_contracts::create_contract(state, base, task_day, slot)?;
    if generated != offer {
        bail!("native orbital-contract offer no longer matches deterministic board generation")
    }
    let mut accepted = offer;
    let accepted_object = accepted.as_object_mut().expect("offer is object");
    accepted_object.insert("status".to_owned(), Value::String("accepted".to_owned()));
    accepted_object.insert("acceptedAtTaskDay".to_owned(), Value::from(task_day));
    board
        .get_mut("offers")
        .and_then(Value::as_array_mut)
        .expect("validated offers")
        .remove(offer_index);
    board
        .get_mut("accepted")
        .and_then(Value::as_array_mut)
        .expect("validated accepted")
        .push(accepted);
    Ok(())
}

fn deliver_quantum(
    state: &CoreState,
    base: &Map<String, Value>,
    station: &mut Map<String, Value>,
    contract_id: &str,
    item_id: &str,
    requested_amount: &str,
) -> anyhow::Result<(String, BigUint)> {
    validate_text("contract ID", contract_id)?;
    validate_text("item ID", item_id)?;
    ensure_item(state, item_id)?;
    let requested = parse_decimal_text(requested_amount, "requested amount")?;
    if requested.is_zero() {
        bail!("native orbital-contract delivery amount is zero")
    }
    let network = base
        .get("quantumLogisticsNetwork")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native orbital-contract quantum network is invalid"))?;
    if network.get("enabled").and_then(Value::as_bool) != Some(true) {
        bail!("native orbital-contract quantum network is disabled")
    }
    let inventory = network
        .get("inventory")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native orbital-contract quantum inventory is invalid"))?;
    let available = decimal(inventory.get(item_id), "quantum inventory")?;
    if available.is_zero() {
        bail!("native orbital-contract quantum inventory is insufficient")
    }
    let board = station
        .get_mut("contractBoard")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native orbital-contract board disappeared"))?;
    let index = board
        .get("accepted")
        .and_then(Value::as_array)
        .expect("validated accepted")
        .iter()
        .position(|value| value.get("id").and_then(Value::as_str) == Some(contract_id))
        .ok_or_else(|| anyhow!("native orbital-contract accepted row is missing"))?;
    let contract = board
        .get_mut("accepted")
        .and_then(Value::as_array_mut)
        .and_then(|accepted| accepted.get_mut(index))
        .and_then(Value::as_object_mut)
        .expect("validated accepted contract");
    if required_str(contract, "status")? != "accepted" {
        bail!("native orbital-contract delivery target is complete")
    }
    let requirements = contract
        .get_mut("requirements")
        .and_then(Value::as_array_mut)
        .expect("validated requirements");
    let total_remaining = requirements
        .iter()
        .try_fold(BigUint::zero(), |sum, value| {
            let row = value.as_object().expect("validated requirement");
            if row.get("itemId").and_then(Value::as_str) != Some(item_id) {
                return Ok::<_, anyhow::Error>(sum);
            }
            let amount = decimal(row.get("amount"), "requirement amount")?;
            let delivered = decimal(row.get("delivered"), "requirement delivered")?;
            Ok(sum + (amount - delivered))
        })?;
    let moved = requested.min(available.clone()).min(total_remaining);
    if moved.is_zero() {
        bail!("native orbital-contract delivery has no movable material")
    }
    let mut remainder = moved.clone();
    for value in requirements.iter_mut() {
        if remainder.is_zero() {
            break;
        }
        let row = value.as_object_mut().expect("validated requirement");
        if row.get("itemId").and_then(Value::as_str) != Some(item_id) {
            continue;
        }
        let amount = decimal(row.get("amount"), "requirement amount")?;
        let delivered = decimal(row.get("delivered"), "requirement delivered")?;
        let accepted = remainder.clone().min(&amount - &delivered);
        if accepted.is_zero() {
            continue;
        }
        row.insert(
            "delivered".to_owned(),
            Value::String((&delivered + &accepted).to_string()),
        );
        remainder -= accepted;
    }
    if completion_basis_points(contract)? == 10_000 {
        contract.insert("status".to_owned(), Value::String("claimable".to_owned()));
    }
    let totals = station
        .get_mut("totals")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native orbital-contract totals disappeared"))?;
    let exported = totals
        .get_mut("exportedByItem")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native orbital-contract export totals disappeared"))?;
    let current = decimal(exported.get(item_id), "export total")?;
    exported.insert(
        item_id.to_owned(),
        Value::String(saturated_decimal_text(current + &moved)),
    );
    Ok((item_id.to_owned(), available - moved))
}

fn settle_active_contract(
    station: &mut Map<String, Value>,
    contract_id: &str,
    require_claimable: bool,
) -> anyhow::Result<()> {
    validate_text("contract ID", contract_id)?;
    let (mut contract, task_day) = {
        let board = station
            .get_mut("contractBoard")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native orbital-contract board disappeared"))?;
        let index = board
            .get("accepted")
            .and_then(Value::as_array)
            .expect("validated accepted")
            .iter()
            .position(|value| value.get("id").and_then(Value::as_str) == Some(contract_id))
            .ok_or_else(|| anyhow!("native orbital-contract accepted row is missing"))?;
        let task_day = safe_u64(board.get("taskDay"), "task day")?;
        let contract = board
            .get_mut("accepted")
            .and_then(Value::as_array_mut)
            .expect("validated accepted")
            .remove(index);
        (contract, task_day)
    };
    let contract_object = contract.as_object_mut().expect("validated contract");
    let status = required_str(contract_object, "status")?.to_owned();
    if require_claimable && status != "claimable" {
        bail!("native orbital-contract claim target is incomplete")
    }
    if !matches!(status.as_str(), "accepted" | "claimable") {
        bail!("native orbital-contract settlement target is invalid")
    }
    let basis = completion_basis_points(contract_object)?;
    let reason = if status == "claimable" {
        "completed"
    } else {
        "abandoned"
    };
    let rewards = deterministic_rewards(contract_object)?;
    let marks = &rewards.base_marks * basis / 10_000_u64
        + if reason == "completed" {
            rewards.completion_marks
        } else {
            BigUint::zero()
        };
    let reputation = &rewards.base_reputation * basis / 10_000_u64
        + if reason == "completed" {
            rewards.completion_reputation
        } else {
            BigUint::zero()
        };
    let economy = station
        .get_mut("economy")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native orbital-contract economy disappeared"))?;
    let current_marks = decimal(economy.get("orbitalMarks"), "orbital marks")?;
    let current_reputation = decimal(economy.get("stationReputation"), "station reputation")?;
    economy.insert(
        "orbitalMarks".to_owned(),
        Value::String(saturated_decimal_text(current_marks + marks)),
    );
    economy.insert(
        "stationReputation".to_owned(),
        Value::String(saturated_decimal_text(current_reputation + reputation)),
    );
    if reason == "completed" {
        let totals = station
            .get_mut("totals")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native orbital-contract totals disappeared"))?;
        let completed = safe_u64(totals.get("completedContracts"), "completed contracts")?;
        totals.insert(
            "completedContracts".to_owned(),
            Value::from(completed.saturating_add(1).min(MAX_SAFE_INTEGER)),
        );
    }
    contract_object.insert("status".to_owned(), Value::String("settled".to_owned()));
    contract_object.insert(
        "settlementId".to_owned(),
        Value::String(format!("station-settlement:{contract_id}:{reason}")),
    );
    contract_object.insert(
        "settlementReason".to_owned(),
        Value::String(reason.to_owned()),
    );
    contract_object.insert("settledAtTaskDay".to_owned(), Value::from(task_day));
    contract_object.insert("completionBasisPoints".to_owned(), Value::from(basis));
    let board = station
        .get_mut("contractBoard")
        .and_then(Value::as_object_mut)
        .expect("validated board");
    let settled_ids = board
        .get_mut("settledIds")
        .and_then(Value::as_array_mut)
        .expect("validated settlement IDs");
    if settled_ids
        .iter()
        .any(|value| value.as_str() == Some(contract_id))
    {
        bail!("native orbital-contract settlement is duplicated")
    }
    settled_ids.push(Value::String(contract_id.to_owned()));
    if settled_ids.len() > MAX_SETTLED_IDS {
        settled_ids.remove(0);
    }
    {
        let history = board
            .get_mut("history")
            .and_then(Value::as_array_mut)
            .expect("validated history");
        history.insert(0, contract);
        history.truncate(MAX_HISTORY);
    }
    let featured_still_available = board
        .get("featuredContractId")
        .and_then(Value::as_str)
        .is_none_or(|featured| {
            board
                .get("history")
                .and_then(Value::as_array)
                .is_some_and(|history| {
                    history.iter().any(|value| {
                        value.get("id").and_then(Value::as_str) == Some(featured)
                            && value.get("settlementReason").and_then(Value::as_str)
                                == Some("completed")
                    })
                })
        });
    if !featured_still_available {
        board.insert("featuredContractId".to_owned(), Value::Null);
    }
    Ok(())
}

fn feature_contract(
    station: &mut Map<String, Value>,
    contract_id: Option<&str>,
) -> anyhow::Result<()> {
    let board = station
        .get_mut("contractBoard")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native orbital-contract board disappeared"))?;
    if board.get("featuredContractId").and_then(Value::as_str) == contract_id {
        bail!("native orbital-contract featured target is unchanged")
    }
    if let Some(contract_id) = contract_id {
        validate_text("featured contract ID", contract_id)?;
        let valid = board
            .get("history")
            .and_then(Value::as_array)
            .expect("validated history")
            .iter()
            .any(|value| {
                value.get("id").and_then(Value::as_str) == Some(contract_id)
                    && value.get("settlementReason").and_then(Value::as_str) == Some("completed")
            });
        if !valid {
            bail!("native orbital-contract featured target is unavailable")
        }
        board.insert(
            "featuredContractId".to_owned(),
            Value::String(contract_id.to_owned()),
        );
    } else {
        board.insert("featuredContractId".to_owned(), Value::Null);
    }
    Ok(())
}

fn completion_basis_points(contract: &Map<String, Value>) -> anyhow::Result<u64> {
    let requirements = bounded_array(
        contract.get("requirements"),
        MAX_REQUIREMENTS,
        "requirements",
    )?;
    let mut weighted = BigUint::zero();
    let mut total_weight = 0_u64;
    for value in requirements {
        let row = value
            .as_object()
            .ok_or_else(|| anyhow!("native orbital-contract requirement is invalid"))?;
        let weight = safe_u64(row.get("weight"), "requirement weight")?;
        let amount = decimal(row.get("amount"), "requirement amount")?;
        let delivered = decimal(row.get("delivered"), "requirement delivered")?;
        if amount.is_zero() || delivered > amount {
            bail!("native orbital-contract requirement progress is invalid")
        }
        weighted += delivered * 10_000_u64 / amount * weight;
        total_weight = total_weight
            .checked_add(weight)
            .ok_or_else(|| anyhow!("native orbital-contract weight overflow"))?;
    }
    if total_weight == 0 {
        return Ok(0);
    }
    Ok((weighted / total_weight)
        .to_u64()
        .unwrap_or(10_000)
        .min(10_000))
}

fn validate_intent(intent: &OrbitalContractIntent) -> anyhow::Result<()> {
    match intent {
        OrbitalContractIntent::Accept { contract_id }
        | OrbitalContractIntent::Claim { contract_id }
        | OrbitalContractIntent::Abandon { contract_id } => {
            validate_text("contract ID", contract_id)
        }
        OrbitalContractIntent::DeliverQuantum {
            contract_id,
            item_id,
            requested_amount,
        } => {
            validate_text("contract ID", contract_id)?;
            validate_text("item ID", item_id)?;
            if parse_decimal_text(requested_amount, "requested amount")?.is_zero() {
                bail!("native orbital-contract requested amount is zero")
            }
            Ok(())
        }
        OrbitalContractIntent::Feature { contract_id } => {
            if let Some(contract_id) = contract_id {
                validate_text("featured contract ID", contract_id)?;
            }
            Ok(())
        }
    }
}

fn validate_text(label: &str, value: &str) -> anyhow::Result<()> {
    if value.is_empty()
        || value.len() > MAX_TEXT_BYTES
        || value
            .chars()
            .any(|character| character == '\0' || character.is_control())
    {
        bail!("native orbital-contract {label} is invalid")
    }
    Ok(())
}

fn required_str<'a>(object: &'a Map<String, Value>, key: &str) -> anyhow::Result<&'a str> {
    let value = object
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("native orbital-contract {key} is invalid"))?;
    validate_text(key, value)?;
    Ok(value)
}

fn bounded_array<'a>(
    value: Option<&'a Value>,
    maximum: usize,
    label: &str,
) -> anyhow::Result<&'a Vec<Value>> {
    let values = value
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("native orbital-contract {label} is invalid"))?;
    if values.len() > maximum {
        bail!("native orbital-contract {label} exceeds its bound")
    }
    Ok(values)
}

fn safe_u64(value: Option<&Value>, label: &str) -> anyhow::Result<u64> {
    value
        .and_then(Value::as_u64)
        .filter(|value| *value <= MAX_SAFE_INTEGER)
        .ok_or_else(|| anyhow!("native orbital-contract {label} is invalid"))
}

fn parse_decimal_text(value: &str, label: &str) -> anyhow::Result<BigUint> {
    if value.is_empty()
        || value.len() > MAX_DECIMAL_DIGITS
        || value.starts_with('0') && value.len() > 1
        || !value.bytes().all(|byte| byte.is_ascii_digit())
    {
        bail!("native orbital-contract {label} is invalid")
    }
    BigUint::parse_bytes(value.as_bytes(), 10)
        .ok_or_else(|| anyhow!("native orbital-contract {label} is invalid"))
}

fn saturated_decimal_text(value: BigUint) -> String {
    let text = value.to_string();
    if text.len() <= MAX_DECIMAL_DIGITS {
        text
    } else {
        "9".repeat(MAX_DECIMAL_DIGITS)
    }
}

fn decimal(value: Option<&Value>, label: &str) -> anyhow::Result<BigUint> {
    match value {
        None => Ok(BigUint::zero()),
        Some(Value::String(value)) => parse_decimal_text(value, label),
        Some(Value::Number(value)) => value
            .as_u64()
            .filter(|value| *value <= MAX_SAFE_INTEGER)
            .map(BigUint::from)
            .ok_or_else(|| anyhow!("native orbital-contract {label} is invalid")),
        _ => bail!("native orbital-contract {label} is invalid"),
    }
}

fn decimal_text(value: Option<&Value>, label: &str) -> anyhow::Result<String> {
    Ok(decimal(value, label)?.to_string())
}

fn ensure_item(state: &CoreState, item_id: &str) -> anyhow::Result<()> {
    if !state.catalog.items.contains_key(item_id) {
        bail!("native orbital-contract item is outside the built-in catalog")
    }
    Ok(())
}

fn empty_patch(state: &CoreState) -> SimulationCommandPatch {
    SimulationCommandPatch {
        protocol_version: CORE_PROTOCOL_VERSION,
        base_revision: state.revision,
        top_level_changes: Vec::new(),
        changed_entities: Vec::new(),
        added_entities: Vec::new(),
        removed_entity_ids: Vec::new(),
        changed_belts: Vec::new(),
        added_belts: Vec::new(),
        removed_belt_ids: Vec::new(),
    }
}

fn set_top(path: &[&str], value: Value) -> ValuePatch {
    ValuePatch {
        path: path
            .iter()
            .map(|value| PathSegment::Key((*value).to_owned()))
            .collect(),
        operation: "set".to_owned(),
        value: Some(value),
    }
}

fn sha256_json(value: &impl Serialize) -> anyhow::Result<String> {
    let bytes = serde_json::to_vec(value)?;
    let mut digest = Sha256::new();
    digest.update(bytes);
    Ok(format!("{:x}", digest.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::{
        BeltDefinition, CatalogSnapshot, ItemDefinition, PlanetDefinition, RuntimeCatalog,
    };
    use crate::state::CoreCheckpointIdentity;
    use std::collections::HashMap;

    const REGISTRY: &str = EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT;
    const SESSION: &str = "core-normal-main-1";
    const RUN: &str = "run-orbital-contracts-1";
    const DAY_100_CLOCK_MS: u64 = 8_611_200_000;

    fn catalog() -> RuntimeCatalog {
        let items = [
            "titanium_alloy",
            "processor",
            "particle_container",
            "titanium_glass",
            "particle_broadband",
            "plastic",
            "space_warper",
            "frame_material",
            "solar_sail",
            "small_carrier_rocket",
            "quantum_chip",
            "antimatter_fuel_rod",
            "universe_matrix",
        ]
        .into_iter()
        .map(|id| ItemDefinition {
            id: id.to_owned(),
            name: id.to_owned(),
            kind: "solid".to_owned(),
            fuel_energy_mj: 0.0,
        })
        .collect();
        RuntimeCatalog::validate(
            CatalogSnapshot {
                protocol_version: 1,
                registry_fingerprint: REGISTRY.to_owned(),
                planets: vec![PlanetDefinition {
                    id: "home".to_owned(),
                    name: "home".to_owned(),
                    system_id: "helios".to_owned(),
                    kind: "terrestrial".to_owned(),
                    orbit_index: 1,
                    simulation_order: 0,
                    orbital_yields: HashMap::new(),
                }],
                items,
                buildings: Vec::new(),
                recipes: Vec::new(),
                constructions: Vec::new(),
                belts: vec![BeltDefinition {
                    tier: 1,
                    speed: 6.0,
                }],
                proliferators: Vec::new(),
                technologies: Vec::new(),
            },
            REGISTRY,
        )
        .unwrap()
    }

    fn offer() -> Value {
        json!({
            "id": "station-contract-v1-7-100-0-single",
            "templateId": "single",
            "slot": 0,
            "title": "processor常规出口",
            "summary": "向轨道贸易航线提交一批标准工业物资。",
            "taskDay": 100,
            "expiresAtTaskDay": 103,
            "special": false,
            "difficulty": "P1",
            "status": "offered",
            "requirements": [{
                "itemId": "processor", "amount": "100", "delivered": "0",
                "channel": "any", "weight": 3
            }],
            "rewards": {
                "baseMarks": "45", "baseReputation": "30",
                "completionMarks": "20", "completionReputation": "15"
            }
        })
    }

    fn base() -> Map<String, Value> {
        json!({
            "version": 47,
            "mode": "normal",
            "contentPacks": [],
            "galaxy": { "seed": 7 },
            "research": { "completedTechIds": ["processor"] },
            "totalProduced": { "processor": 1 },
            "exploration": { "colonizedPlanetIds": ["home"] },
            "quantumLogisticsNetwork": {
                "enabled": true,
                "inventory": { "processor": "75" }
            },
            "orbitalStation": {
                "status": "operational",
                "contractBoard": {
                    "rulesVersion": 1,
                    "taskDay": 100,
                    "lastConfirmedWallClockMs": DAY_100_CLOCK_MS,
                    "offers": [offer()],
                    "accepted": [],
                    "history": [],
                    "settledIds": [],
                    "featuredContractId": null
                },
                "economy": {
                    "orbitalMarks": "0", "stationReputation": "0",
                    "unlockedDecorationIds": []
                },
                "totals": { "completedContracts": 0, "exportedByItem": {} }
            }
        })
        .as_object()
        .unwrap()
        .clone()
    }

    fn state_with(base: Map<String, Value>) -> CoreState {
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
            Vec::new(),
            Vec::new(),
            catalog(),
        )
        .unwrap()
    }

    fn request(intent: OrbitalContractIntent) -> OrbitalContractCommandRequest {
        let mut request = OrbitalContractCommandRequest {
            command_id: "placeholder".to_owned(),
            session_id: SESSION.to_owned(),
            run_id: RUN.to_owned(),
            expected_revision: 41,
            expected_registry_fingerprint: REGISTRY.to_owned(),
            confirmed_wall_clock_ms: DAY_100_CLOCK_MS,
            intent,
        };
        request.command_id = derive_orbital_contract_command_id(&request).unwrap();
        request
    }

    fn authority() -> OrbitalContractAuthority {
        OrbitalContractAuthority {
            session_id: SESSION.to_owned(),
            run_id: RUN.to_owned(),
        }
    }

    fn accepted_base() -> Map<String, Value> {
        let mut base = base();
        let mut contract = offer();
        contract["status"] = json!("accepted");
        contract["acceptedAtTaskDay"] = json!(100);
        base["orbitalStation"]["contractBoard"]["offers"] = json!([]);
        base["orbitalStation"]["contractBoard"]["accepted"] = json!([contract]);
        base
    }

    fn completed_history_contract(task_day: u64) -> Value {
        let mut contract = offer();
        let id = format!("station-contract-v1-7-{task_day}-0-single");
        contract["id"] = json!(id);
        contract["taskDay"] = json!(task_day);
        contract["expiresAtTaskDay"] = json!(task_day + 3);
        contract["status"] = json!("settled");
        contract["acceptedAtTaskDay"] = json!(task_day);
        contract["requirements"][0]["delivered"] = json!("100");
        contract["settlementId"] = json!(format!("station-settlement:{id}:completed"));
        contract["settlementReason"] = json!("completed");
        contract["settledAtTaskDay"] = json!(task_day + 1);
        contract["completionBasisPoints"] = json!(10_000);
        contract
    }

    #[test]
    fn accept_reproves_the_current_offer_against_rust_generation() {
        let mut source = base();
        source["orbitalStation"]["contractBoard"]["offers"] = json!([]);
        let source_state = state_with(source);
        let generated = crate::station_contracts::create_contract(
            &source_state,
            source_state.base_value(),
            100,
            0,
        )
        .unwrap();
        let contract_id = generated["id"].as_str().unwrap().to_owned();
        let mut current = source_state.base_value().clone();
        current["orbitalStation"]["contractBoard"]["offers"] = json!([generated]);
        let mut state = state_with(current);
        let prepared = prepare_orbital_contract_command(
            &state,
            &authority(),
            request(OrbitalContractIntent::Accept {
                contract_id: contract_id.clone(),
            }),
        )
        .unwrap();
        prepared.apply(&mut state, &authority()).unwrap();
        assert!(
            state.base_value()["orbitalStation"]["contractBoard"]["offers"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            state.base_value()["orbitalStation"]["contractBoard"]["accepted"][0]["id"],
            contract_id
        );
        assert_eq!(
            state.base_value()["orbitalStation"]["contractBoard"]["accepted"][0]["status"],
            "accepted"
        );
    }

    #[test]
    fn projection_is_bounded_read_only_and_hides_full_state() {
        let state = state_with(accepted_base());
        let before = state.canonical_sha256().unwrap();
        let projection = state
            .orbital_contract_workspace_projection(SESSION, RUN, 41, REGISTRY, DAY_100_CLOCK_MS)
            .unwrap();
        assert_eq!(
            projection["projectionType"],
            ORBITAL_CONTRACT_WORKSPACE_PROJECTION
        );
        assert_eq!(
            projection["accepted"][0]["requirements"][0]["availableQuantum"],
            "75"
        );
        assert_eq!(projection["accepted"][0]["rewardMarks"], "65");
        assert!(serde_json::to_vec(&projection).unwrap().len() <= MAX_PROJECTION_BYTES);
        let encoded = serde_json::to_string(&projection).unwrap();
        assert!(!encoded.contains("quantumLogisticsNetwork"));
        assert!(!encoded.contains("layout"));
        assert_eq!(state.canonical_sha256().unwrap(), before);
    }

    #[test]
    fn quantum_delivery_recomputes_the_bound_and_conserves_inventory() {
        let mut state = state_with(accepted_base());
        let prepared = prepare_orbital_contract_command(
            &state,
            &authority(),
            request(OrbitalContractIntent::DeliverQuantum {
                contract_id: "station-contract-v1-7-100-0-single".to_owned(),
                item_id: "processor".to_owned(),
                requested_amount: "999999".to_owned(),
            }),
        )
        .unwrap();
        prepared.apply(&mut state, &authority()).unwrap();
        assert_eq!(
            state.base_value()["quantumLogisticsNetwork"]["inventory"]["processor"],
            "0"
        );
        assert_eq!(
            state.base_value()["orbitalStation"]["contractBoard"]["accepted"][0]["requirements"][0]
                ["delivered"],
            "75"
        );
        assert_eq!(
            state.base_value()["orbitalStation"]["totals"]["exportedByItem"]["processor"],
            "75"
        );
    }

    #[test]
    fn insufficient_inventory_and_stale_revision_do_not_mutate_source() {
        let mut base = accepted_base();
        base["quantumLogisticsNetwork"]["inventory"]["processor"] = json!("0");
        let state = state_with(base);
        let before = state.canonical_sha256().unwrap();
        assert!(
            prepare_orbital_contract_command(
                &state,
                &authority(),
                request(OrbitalContractIntent::DeliverQuantum {
                    contract_id: "station-contract-v1-7-100-0-single".to_owned(),
                    item_id: "processor".to_owned(),
                    requested_amount: "1".to_owned(),
                }),
            )
            .is_err()
        );
        let mut stale = request(OrbitalContractIntent::Abandon {
            contract_id: "station-contract-v1-7-100-0-single".to_owned(),
        });
        stale.expected_revision = 40;
        assert!(prepare_orbital_contract_command(&state, &authority(), stale).is_err());
        assert_eq!(state.canonical_sha256().unwrap(), before);
    }

    #[test]
    fn claim_recomputes_reward_archives_once_and_feature_toggles() {
        let mut base = accepted_base();
        base["orbitalStation"]["contractBoard"]["accepted"][0]["requirements"][0]["delivered"] =
            json!("100");
        base["orbitalStation"]["contractBoard"]["accepted"][0]["status"] = json!("claimable");
        let mut state = state_with(base);
        let claim = prepare_orbital_contract_command(
            &state,
            &authority(),
            request(OrbitalContractIntent::Claim {
                contract_id: "station-contract-v1-7-100-0-single".to_owned(),
            }),
        )
        .unwrap();
        claim.apply(&mut state, &authority()).unwrap();
        assert_eq!(
            state.base_value()["orbitalStation"]["economy"]["orbitalMarks"],
            "65"
        );
        assert_eq!(
            state.base_value()["orbitalStation"]["economy"]["stationReputation"],
            "45"
        );
        assert_eq!(
            state.base_value()["orbitalStation"]["totals"]["completedContracts"],
            1
        );
        assert_eq!(
            state.base_value()["orbitalStation"]["contractBoard"]["history"][0]["settlementReason"],
            "completed"
        );
        let feature_request = request_for_revision(
            42,
            OrbitalContractIntent::Feature {
                contract_id: Some("station-contract-v1-7-100-0-single".to_owned()),
            },
        );
        let feature =
            prepare_orbital_contract_command(&state, &authority(), feature_request).unwrap();
        feature.apply(&mut state, &authority()).unwrap();
        assert_eq!(
            state.base_value()["orbitalStation"]["contractBoard"]["featuredContractId"],
            "station-contract-v1-7-100-0-single"
        );
    }

    fn request_for_revision(
        revision: u64,
        intent: OrbitalContractIntent,
    ) -> OrbitalContractCommandRequest {
        let mut request = OrbitalContractCommandRequest {
            command_id: "placeholder".to_owned(),
            session_id: SESSION.to_owned(),
            run_id: RUN.to_owned(),
            expected_revision: revision,
            expected_registry_fingerprint: REGISTRY.to_owned(),
            confirmed_wall_clock_ms: DAY_100_CLOCK_MS,
            intent,
        };
        request.command_id = derive_orbital_contract_command_id(&request).unwrap();
        request
    }

    #[test]
    fn abandon_partially_settles_only_the_recomputed_base_reward() {
        let mut base = accepted_base();
        base["orbitalStation"]["contractBoard"]["accepted"][0]["requirements"][0]["delivered"] =
            json!("50");
        let mut state = state_with(base);
        let command = prepare_orbital_contract_command(
            &state,
            &authority(),
            request(OrbitalContractIntent::Abandon {
                contract_id: "station-contract-v1-7-100-0-single".to_owned(),
            }),
        )
        .unwrap();
        command.apply(&mut state, &authority()).unwrap();
        assert_eq!(
            state.base_value()["orbitalStation"]["economy"]["orbitalMarks"],
            "22"
        );
        assert_eq!(
            state.base_value()["orbitalStation"]["economy"]["stationReputation"],
            "15"
        );
        assert_eq!(
            state.base_value()["orbitalStation"]["contractBoard"]["history"][0]["completionBasisPoints"],
            5_000
        );
    }

    #[test]
    fn malformed_reward_or_oversized_board_fails_closed() {
        let mut corrupt = accepted_base();
        corrupt["orbitalStation"]["contractBoard"]["accepted"][0]["rewards"]["baseMarks"] =
            json!("999999");
        assert!(state_with(corrupt)
            .orbital_contract_workspace_projection(SESSION, RUN, 41, REGISTRY, DAY_100_CLOCK_MS,)
            .is_err());
        let mut oversized = base();
        oversized["orbitalStation"]["contractBoard"]["offers"] = Value::Array(vec![offer(); 5]);
        assert!(state_with(oversized)
            .orbital_contract_workspace_projection(SESSION, RUN, 41, REGISTRY, DAY_100_CLOCK_MS,)
            .is_err());
    }

    #[test]
    fn semantic_command_id_is_stable_and_binds_every_intent_field() {
        let first = request(OrbitalContractIntent::DeliverQuantum {
            contract_id: "station-contract-v1-7-100-0-single".to_owned(),
            item_id: "processor".to_owned(),
            requested_amount: "25".to_owned(),
        });
        assert_eq!(
            first.command_id,
            derive_orbital_contract_command_id(&first).unwrap()
        );
        let mut changed = first.clone();
        changed.intent = OrbitalContractIntent::DeliverQuantum {
            contract_id: "station-contract-v1-7-100-0-single".to_owned(),
            item_id: "processor".to_owned(),
            requested_amount: "26".to_owned(),
        };
        assert_ne!(
            derive_orbital_contract_command_id(&first).unwrap(),
            derive_orbital_contract_command_id(&changed).unwrap()
        );
        let mut changed_clock = first.clone();
        changed_clock.confirmed_wall_clock_ms += 1;
        assert_ne!(
            derive_orbital_contract_command_id(&first).unwrap(),
            derive_orbital_contract_command_id(&changed_clock).unwrap()
        );
        let mut exhausted = first.clone();
        exhausted.expected_revision = MAX_SAFE_INTEGER;
        assert!(orbital_contract_semantic_sha256(&exhausted).is_err());
        assert!(
            serde_json::from_value::<OrbitalContractIntent>(json!({
                "type": "claim",
                "contractId": "station-contract-v1-7-100-0-single",
                "reward": "renderer-supplied"
            }))
            .is_err()
        );
    }

    #[test]
    fn projection_uses_the_shanghai_midnight_fence_without_mutating_source() {
        const DAY_101_CLOCK_MS: u64 = 8_697_600_000;
        let state = state_with(accepted_base());
        let before_hash = state.canonical_sha256().unwrap();
        let before_midnight = state
            .orbital_contract_workspace_projection(SESSION, RUN, 41, REGISTRY, DAY_101_CLOCK_MS - 1)
            .unwrap();
        let at_midnight = state
            .orbital_contract_workspace_projection(SESSION, RUN, 41, REGISTRY, DAY_101_CLOCK_MS)
            .unwrap();
        assert_eq!(before_midnight["taskDay"], 100);
        assert_eq!(at_midnight["taskDay"], 101);
        assert!(
            at_midnight["offers"]
                .as_array()
                .unwrap()
                .iter()
                .all(|contract| contract["taskDay"] == 101)
        );
        assert_eq!(
            state.base_value()["orbitalStation"]["contractBoard"]["taskDay"],
            100
        );
        assert_eq!(state.canonical_sha256().unwrap(), before_hash);
    }

    #[test]
    fn old_offer_rejects_atomically_and_a_fresh_projection_rolls_forward() {
        const DAY_101_CLOCK_MS: u64 = 8_697_600_000;
        let mut source = base();
        source["orbitalStation"]["contractBoard"]["offers"] = json!([]);
        let source_state = state_with(source);
        let generated = crate::station_contracts::create_contract(
            &source_state,
            source_state.base_value(),
            100,
            0,
        )
        .unwrap();
        let old_id = generated["id"].as_str().unwrap().to_owned();
        let mut current = source_state.base_value().clone();
        current["orbitalStation"]["contractBoard"]["offers"] = json!([generated]);
        let state = state_with(current);
        let before = state.canonical_sha256().unwrap();
        let mut stale = request(OrbitalContractIntent::Accept {
            contract_id: old_id.clone(),
        });
        stale.confirmed_wall_clock_ms = DAY_101_CLOCK_MS;
        stale.command_id = derive_orbital_contract_command_id(&stale).unwrap();
        assert!(prepare_orbital_contract_command(&state, &authority(), stale).is_err());
        assert_eq!(state.canonical_sha256().unwrap(), before);

        let fresh = state
            .orbital_contract_workspace_projection(SESSION, RUN, 41, REGISTRY, DAY_101_CLOCK_MS)
            .unwrap();
        assert_eq!(fresh["taskDay"], 101);
        assert!(
            fresh["offers"]
                .as_array()
                .unwrap()
                .iter()
                .all(|contract| contract["id"] != old_id)
        );
    }

    #[test]
    fn successful_intent_expires_and_rolls_the_board_in_the_same_patch() {
        const DAY_103_CLOCK_MS: u64 = 8_870_400_000;
        let mut source = accepted_base();
        let featured_candidate = completed_history_contract(99);
        let featured_id = featured_candidate["id"].as_str().unwrap().to_owned();
        source["orbitalStation"]["contractBoard"]["history"] = json!([featured_candidate]);
        source["orbitalStation"]["contractBoard"]["settledIds"] = json!([featured_id]);
        let mut state = state_with(source);
        let mut command = request(OrbitalContractIntent::Feature {
            contract_id: Some(featured_id.clone()),
        });
        command.confirmed_wall_clock_ms = DAY_103_CLOCK_MS;
        command.command_id = derive_orbital_contract_command_id(&command).unwrap();
        let prepared = prepare_orbital_contract_command(&state, &authority(), command).unwrap();
        prepared.apply(&mut state, &authority()).unwrap();
        let board = &state.base_value()["orbitalStation"]["contractBoard"];
        assert_eq!(board["taskDay"], 103);
        assert_eq!(board["lastConfirmedWallClockMs"], DAY_103_CLOCK_MS);
        assert!(board["accepted"].as_array().unwrap().is_empty());
        assert_eq!(board["history"][0]["settlementReason"], "expired");
        assert_eq!(board["featuredContractId"], featured_id);
        assert!(
            board["offers"]
                .as_array()
                .unwrap()
                .iter()
                .all(|contract| contract["taskDay"] == 103)
        );
    }

    #[test]
    fn station_integer_ledgers_and_completion_count_saturate_at_web_limits() {
        let maximum = "9".repeat(MAX_DECIMAL_DIGITS);
        let mut delivery_base = accepted_base();
        delivery_base["orbitalStation"]["contractBoard"]["accepted"][0]["requirements"][0]["amount"] =
            json!(maximum);
        delivery_base["quantumLogisticsNetwork"]["inventory"]["processor"] = json!(maximum);
        delivery_base["orbitalStation"]["totals"]["exportedByItem"]["processor"] = json!(maximum);
        let mut delivery_state = state_with(delivery_base);
        let delivery = prepare_orbital_contract_command(
            &delivery_state,
            &authority(),
            request(OrbitalContractIntent::DeliverQuantum {
                contract_id: "station-contract-v1-7-100-0-single".to_owned(),
                item_id: "processor".to_owned(),
                requested_amount: "1".to_owned(),
            }),
        )
        .unwrap();
        delivery.apply(&mut delivery_state, &authority()).unwrap();
        assert_eq!(
            delivery_state.base_value()["orbitalStation"]["totals"]["exportedByItem"]["processor"],
            maximum
        );

        let mut claim_base = accepted_base();
        claim_base["orbitalStation"]["contractBoard"]["accepted"][0]["requirements"][0]["delivered"] =
            json!("100");
        claim_base["orbitalStation"]["contractBoard"]["accepted"][0]["status"] = json!("claimable");
        claim_base["orbitalStation"]["economy"]["orbitalMarks"] = json!(maximum);
        claim_base["orbitalStation"]["economy"]["stationReputation"] = json!(maximum);
        claim_base["orbitalStation"]["totals"]["completedContracts"] = json!(MAX_SAFE_INTEGER);
        let mut claim_state = state_with(claim_base);
        let claim = prepare_orbital_contract_command(
            &claim_state,
            &authority(),
            request(OrbitalContractIntent::Claim {
                contract_id: "station-contract-v1-7-100-0-single".to_owned(),
            }),
        )
        .unwrap();
        claim.apply(&mut claim_state, &authority()).unwrap();
        assert_eq!(
            claim_state.base_value()["orbitalStation"]["economy"]["orbitalMarks"],
            maximum
        );
        assert_eq!(
            claim_state.base_value()["orbitalStation"]["economy"]["stationReputation"],
            maximum
        );
        assert_eq!(
            claim_state.base_value()["orbitalStation"]["totals"]["completedContracts"],
            MAX_SAFE_INTEGER
        );
    }

    #[test]
    fn projection_keeps_an_old_featured_contract_inside_the_eight_row_bound() {
        let mut source = base();
        source["orbitalStation"]["contractBoard"]["offers"] = json!([]);
        let history = (0..12)
            .map(|offset| completed_history_contract(99 - offset))
            .collect::<Vec<_>>();
        let settled_ids = history
            .iter()
            .map(|contract| contract["id"].clone())
            .collect::<Vec<_>>();
        let featured = history[10]["id"].clone();
        source["orbitalStation"]["contractBoard"]["history"] = Value::Array(history);
        source["orbitalStation"]["contractBoard"]["settledIds"] = Value::Array(settled_ids);
        source["orbitalStation"]["contractBoard"]["featuredContractId"] = featured.clone();
        let state = state_with(source);
        let projection = state
            .orbital_contract_workspace_projection(SESSION, RUN, 41, REGISTRY, DAY_100_CLOCK_MS)
            .unwrap();
        let rows = projection["completedHistory"].as_array().unwrap();
        assert_eq!(rows.len(), MAX_PROJECTED_HISTORY);
        assert_eq!(rows.last().unwrap()["id"], featured);
        let unique = rows
            .iter()
            .map(|row| row["id"].as_str().unwrap())
            .collect::<HashSet<_>>();
        assert_eq!(unique.len(), MAX_PROJECTED_HISTORY);

        let rolled = state
            .orbital_contract_workspace_projection(SESSION, RUN, 41, REGISTRY, 8_870_400_000)
            .unwrap();
        assert_eq!(rolled["featuredContractId"], featured);
    }

    #[test]
    fn full_history_rollover_clears_only_a_featured_contract_evicted_by_truncation() {
        const DAY_103_CLOCK_MS: u64 = 8_870_400_000;
        let mut source = accepted_base();
        let history = (0..MAX_HISTORY)
            .map(|offset| completed_history_contract(99 - offset as u64))
            .collect::<Vec<_>>();
        let settled_ids = history
            .iter()
            .map(|contract| contract["id"].clone())
            .collect::<Vec<_>>();
        let evicted_featured = history.last().unwrap()["id"].clone();
        let retained_target = history[0]["id"].as_str().unwrap().to_owned();
        source["orbitalStation"]["contractBoard"]["history"] = Value::Array(history);
        source["orbitalStation"]["contractBoard"]["settledIds"] = Value::Array(settled_ids);
        source["orbitalStation"]["contractBoard"]["featuredContractId"] = evicted_featured.clone();
        let state = state_with(source.clone());
        let projected = state
            .orbital_contract_workspace_projection(SESSION, RUN, 41, REGISTRY, DAY_103_CLOCK_MS)
            .unwrap();
        assert_eq!(projected["taskDay"], 103);
        assert_eq!(projected["featuredContractId"], Value::Null);
        assert!(
            projected["completedHistory"]
                .as_array()
                .unwrap()
                .iter()
                .all(|row| row["id"] != evicted_featured)
        );
        assert_eq!(
            state.base_value()["orbitalStation"]["contractBoard"]["taskDay"],
            100
        );

        let mut durable = state_with(source);
        let mut command = request(OrbitalContractIntent::Feature {
            contract_id: Some(retained_target.clone()),
        });
        command.confirmed_wall_clock_ms = DAY_103_CLOCK_MS;
        command.command_id = derive_orbital_contract_command_id(&command).unwrap();
        let prepared = prepare_orbital_contract_command(&durable, &authority(), command).unwrap();
        prepared.apply(&mut durable, &authority()).unwrap();
        let durable_board = &durable.base_value()["orbitalStation"]["contractBoard"];
        assert_eq!(durable_board["taskDay"], 103);
        assert_eq!(durable_board["featuredContractId"], retained_target);
        assert!(
            durable_board["history"]
                .as_array()
                .unwrap()
                .iter()
                .all(|row| row["id"] != evicted_featured)
        );
    }

    #[test]
    fn direct_claim_and_abandon_clear_a_featured_contract_evicted_from_full_history() {
        for claimable in [true, false] {
            let mut source = accepted_base();
            if claimable {
                source["orbitalStation"]["contractBoard"]["accepted"][0]["requirements"][0]["delivered"] =
                    json!("100");
                source["orbitalStation"]["contractBoard"]["accepted"][0]["status"] =
                    json!("claimable");
            } else {
                source["orbitalStation"]["contractBoard"]["accepted"][0]["requirements"][0]["delivered"] =
                    json!("50");
            }
            let history = (0..MAX_HISTORY)
                .map(|offset| completed_history_contract(99 - offset as u64))
                .collect::<Vec<_>>();
            let settled_ids = history
                .iter()
                .map(|contract| contract["id"].clone())
                .collect::<Vec<_>>();
            let evicted_featured = history.last().unwrap()["id"].clone();
            source["orbitalStation"]["contractBoard"]["history"] = Value::Array(history);
            source["orbitalStation"]["contractBoard"]["settledIds"] = Value::Array(settled_ids);
            source["orbitalStation"]["contractBoard"]["featuredContractId"] =
                evicted_featured.clone();

            let mut state = state_with(source);
            let intent = if claimable {
                OrbitalContractIntent::Claim {
                    contract_id: "station-contract-v1-7-100-0-single".to_owned(),
                }
            } else {
                OrbitalContractIntent::Abandon {
                    contract_id: "station-contract-v1-7-100-0-single".to_owned(),
                }
            };
            let prepared =
                prepare_orbital_contract_command(&state, &authority(), request(intent)).unwrap();
            prepared.apply(&mut state, &authority()).unwrap();
            let board = &state.base_value()["orbitalStation"]["contractBoard"];
            assert_eq!(board["featuredContractId"], Value::Null);
            assert_eq!(board["history"].as_array().unwrap().len(), MAX_HISTORY);
            assert!(
                board["history"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|row| row["id"] != evicted_featured)
            );
            state
                .orbital_contract_workspace_projection(SESSION, RUN, 42, REGISTRY, DAY_100_CLOCK_MS)
                .unwrap();
        }
    }
}
