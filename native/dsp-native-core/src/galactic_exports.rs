use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap};

use anyhow::{anyhow, bail};
use serde_json::{Map, Number, Value};

use crate::deterministic_runtime::{DeterministicRuntime, runtime as deterministic_runtime};
use crate::state::CoreState;

const EPSILON: f64 = 0.0001;
const MAX_SAFE_INTEGER: i128 = 9_007_199_254_740_991;
const MAX_WORKSPACE_DECIMAL_DIGITS: usize = 256;

#[derive(Clone, Copy)]
struct Definition {
    id: &'static str,
    item_id: &'static str,
    base_target: f64,
    target_growth: f64,
    credits_per_item: f64,
    base_rate_per_minute: f64,
    reserve: f64,
}

const DEFINITIONS: [Definition; 4] = [
    Definition {
        id: "universe_archive",
        item_id: "universe_matrix",
        base_target: 1_000.0,
        target_growth: 1.55,
        credits_per_item: 12.0,
        base_rate_per_minute: 120.0,
        reserve: 120.0,
    },
    Definition {
        id: "solar_sail_array",
        item_id: "solar_sail",
        base_target: 5_000.0,
        target_growth: 1.5,
        credits_per_item: 3.0,
        base_rate_per_minute: 360.0,
        reserve: 240.0,
    },
    Definition {
        id: "carrier_rocket_fleet",
        item_id: "small_carrier_rocket",
        base_target: 1_000.0,
        target_growth: 1.52,
        credits_per_item: 24.0,
        base_rate_per_minute: 60.0,
        reserve: 60.0,
    },
    Definition {
        id: "antimatter_exchange",
        item_id: "antimatter_fuel_rod",
        base_target: 500.0,
        target_growth: 1.58,
        credits_per_item: 80.0,
        base_rate_per_minute: 30.0,
        reserve: 24.0,
    },
];

/// Runtime-only, exact endpoint for a certified pure-idle export terminal.
///
/// The endpoint deliberately excludes every tray, entity cache and quantum
/// inventory. A caller may use only newly-produced material that it has
/// independently certified; pre-existing owned stock is never a source for
/// the terminal helper below.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CertifiedPureIdleExportEndpoint {
    pub endgame_unlocked: bool,
    pub input_mode: CertifiedPureIdleExportInputMode,
    pub auto_dispatch: bool,
    pub dispatch_throttle_bits: u64,
    pub galactic_logistics_level: i128,
    pub projects: BTreeMap<String, CertifiedPureIdleExportProjectEndpoint>,
    pub galactic_credits: i128,
    pub galactic_score: i128,
    pub total_exported: i128,
    pub exported_last_minute_bits: u64,
    pub export_window_amount: i128,
    pub export_window_started_at_bits: u64,
    pub activity: CertifiedPureIdleExportActivityEndpoint,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CertifiedPureIdleExportInputMode {
    Building,
    LegacyNetwork,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CertifiedPureIdleExportProjectEndpoint {
    pub project_id: String,
    pub item_id: String,
    pub enabled: bool,
    pub priority: u8,
    pub level: i128,
    pub delivered: i128,
    pub total_delivered: i128,
    pub dispatch_progress_bits: u64,
    /// The first additional unit count that would complete the current level
    /// and therefore grant a level reward.
    pub units_until_level_reward: i128,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CertifiedPureIdleExportActivityPhase {
    Inactive,
    Scheduled,
    Active,
    Ended,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CertifiedPureIdleExportActivityEndpoint {
    pub activity_id: Option<String>,
    pub participant_id: Option<String>,
    pub config_revision: Option<String>,
    pub starts_at_ms: i128,
    pub ends_at_ms: i128,
    pub server_time_anchor_ms: i128,
    pub activity_clock_ms: i128,
    pub phase: CertifiedPureIdleExportActivityPhase,
    /// Milliseconds until the next start/end boundary. Zero means that no
    /// forward activity interval can be certified from this endpoint.
    pub millis_until_boundary: i128,
    pub personal_delivered: BTreeMap<String, i128>,
    pub pending_batches: BTreeMap<String, CertifiedPureIdleExportBatchEndpoint>,
    pub next_batch_sequence: i128,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CertifiedPureIdleExportBatchEndpoint {
    pub id: String,
    pub item_id: String,
    pub amount: i128,
    pub sequence: i128,
    pub first_delivered_at_ms: i128,
    pub last_delivered_at_ms: i128,
}

/// Snapshot-to-snapshot proof. `physical_consumed_by_item` is sourced only
/// from project `totalDelivered`; activity counters are reporting mirrors and
/// explicitly are not a second material sink or recoverable inventory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CertifiedPureIdleExportEndpointDelta {
    pub physical_consumed_by_item: BTreeMap<String, i128>,
    pub activity_personal_mirror_by_item: BTreeMap<String, i128>,
    pub activity_pending_mirror_by_item: BTreeMap<String, i128>,
    pub reward_credits: i128,
    pub reward_score: i128,
    pub total_exported: i128,
    pub activity_clock_advanced_ms: i128,
    pub level_boundaries: BTreeMap<String, CertifiedPureIdleExportLevelBoundary>,
    pub pending_activity_batches_are_owned_inventory: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CertifiedPureIdleExportLevelBoundary {
    pub project_id: String,
    pub level_before: i128,
    pub level_after: i128,
    pub delivered_before: i128,
    pub delivered_after: i128,
    pub units_until_level_reward_before: i128,
    pub units_until_level_reward_after: i128,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CertifiedPureIdleExportItemReceipt {
    pub project_id: String,
    pub requested_budget: i128,
    pub consumed: i128,
    pub unconsumed_budget: i128,
    pub reward_credits: i128,
    pub reward_score: i128,
    pub level_before: i128,
    pub level_after: i128,
    pub units_until_level_reward_before: i128,
    pub units_until_level_reward_after: i128,
    pub boundary_limited: bool,
    pub counter_limited: bool,
    pub configuration_limited: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CertifiedPureIdleExportReceipt {
    pub requested_by_item: BTreeMap<String, i128>,
    pub consumed_by_item: BTreeMap<String, i128>,
    pub items: BTreeMap<String, CertifiedPureIdleExportItemReceipt>,
    pub reward_credits: i128,
    pub reward_score: i128,
    pub activity_personal_mirror_by_item: BTreeMap<String, i128>,
    pub activity_pending_mirror_by_item: BTreeMap<String, i128>,
    pub clipped: bool,
    pub boundary_limited: bool,
    pub pending_activity_batches_are_owned_inventory: bool,
    pub endpoint_after: CertifiedPureIdleExportEndpoint,
}

#[derive(Debug, Clone, PartialEq)]
struct ExporterProbe {
    entity_index: usize,
    allocated_power: bool,
    power_factor: f64,
    paused: bool,
    buffered_by_definition: [f64; DEFINITIONS.len()],
}

fn collect_ordered_exporter_probes_with_runtime<R, F>(
    runtime: &DeterministicRuntime,
    entity_indices: &[usize],
    probe: F,
) -> anyhow::Result<Vec<R>>
where
    R: Send,
    F: Fn(usize) -> anyhow::Result<R> + Send + Sync,
{
    // Indexed collection retains topology order. All workers finish before
    // the first error is selected, so scheduling can neither choose the
    // visible error nor reorder the serial shared-ledger replay.
    runtime
        .indexed_map(entity_indices, |_, entity_index| probe(*entity_index))
        .into_iter()
        .collect()
}

fn probe_exporter(
    entities: &[Value],
    effective_power: &HashMap<usize, f64>,
    allocated_power: &HashMap<usize, f64>,
    entity_index: usize,
) -> anyhow::Result<ExporterProbe> {
    let entity = entities
        .get(entity_index)
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native galactic exporter is invalid"))?;
    let mut buffered_by_definition = [0.0; DEFINITIONS.len()];
    for (definition_index, definition) in DEFINITIONS.iter().enumerate() {
        buffered_by_definition[definition_index] = finite_number(
            entity
                .get("inputs")
                .and_then(Value::as_object)
                .and_then(|inputs| inputs.get(definition.item_id)),
        )
        .floor()
        .max(0.0);
    }
    Ok(ExporterProbe {
        entity_index,
        allocated_power: allocated_power.contains_key(&entity_index),
        power_factor: effective_power.get(&entity_index).copied().unwrap_or(0.0),
        paused: entity
            .get("galacticExporterPaused")
            .and_then(Value::as_bool)
            != Some(false),
        buffered_by_definition,
    })
}

fn finite_number(value: Option<&Value>) -> f64 {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .unwrap_or(0.0)
}

fn set_number(object: &mut Map<String, Value>, key: &str, value: f64) -> anyhow::Result<()> {
    object.insert(
        key.to_owned(),
        Number::from_f64(value)
            .map(Value::Number)
            .ok_or_else(|| anyhow!("native galactic export produced a non-finite number"))?,
    );
    Ok(())
}

fn completed_tech(base: &Map<String, Value>, id: &str) -> bool {
    base.get("research")
        .and_then(Value::as_object)
        .and_then(|research| research.get("completedTechIds"))
        .and_then(Value::as_array)
        .is_some_and(|ids| ids.iter().any(|value| value.as_str() == Some(id)))
}

fn target(definition: Definition, level: f64) -> f64 {
    (definition.base_target * definition.target_growth.powf(level.floor().max(0.0)))
        .round()
        .clamp(1.0, 2_000_000_000.0)
}

fn reward(definition: Definition, level: f64) -> f64 {
    (target(definition, level) * definition.credits_per_item)
        .floor()
        .max(1.0)
}

fn project<'a>(
    endgame: &'a mut Map<String, Value>,
    id: &str,
) -> anyhow::Result<&'a mut Map<String, Value>> {
    endgame
        .get_mut("exportProjects")
        .and_then(Value::as_object_mut)
        .and_then(|projects| projects.get_mut(id))
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native galactic export project is missing"))
}

fn complete_levels(endgame: &mut Map<String, Value>, definition: Definition) -> anyhow::Result<()> {
    loop {
        let (delivered, level) = {
            let project = project(endgame, definition.id)?;
            (
                finite_number(project.get("delivered")),
                finite_number(project.get("level")),
            )
        };
        let required = target(definition, level);
        if delivered < required {
            return Ok(());
        }
        {
            let project = project(endgame, definition.id)?;
            set_number(project, "delivered", delivered - required)?;
            set_number(project, "level", level + 1.0)?;
        }
        let earned = reward(definition, level);
        for key in ["galacticCredits", "galacticScore"] {
            let current = finite_number(endgame.get(key));
            set_number(endgame, key, (current + earned).floor())?;
        }
    }
}

fn record_activity_delivery(
    endgame: &mut Map<String, Value>,
    definition: Definition,
    shipped: f64,
) -> anyhow::Result<()> {
    let activity = endgame
        .get_mut("constructionActivity")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native galactic construction activity is missing"))?;
    let activity_id = activity
        .get("activityId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let participant_id = activity
        .get("participantId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    if activity_id.is_empty() || participant_id.is_empty() {
        return Ok(());
    }
    let clock = finite_number(activity.get("activityClockMs"));
    let personal = activity
        .get_mut("personalDelivered")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native personal export delivery state is missing"))?;
    let personal_total = finite_number(personal.get(definition.item_id));
    set_number(
        personal,
        definition.item_id,
        (personal_total + shipped).floor(),
    )?;
    let existing = activity
        .get_mut("pendingBatches")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native pending export batches are missing"))?
        .get_mut(definition.item_id)
        .and_then(Value::as_object_mut);
    if let Some(batch) = existing {
        let amount = finite_number(batch.get("amount"));
        set_number(batch, "amount", (amount + shipped).floor())?;
        set_number(batch, "lastDeliveredAtMs", clock)?;
        return Ok(());
    }
    let sequence = finite_number(activity.get("nextBatchSequence"));
    set_number(activity, "nextBatchSequence", sequence + 1.0)?;
    let sequence_label = if sequence.fract().abs() <= f64::EPSILON {
        format!("{:.0}", sequence)
    } else {
        sequence.to_string()
    };
    let batch = serde_json::json!({
        "id": format!("{activity_id}:{participant_id}:{}:{sequence_label}", definition.item_id),
        "itemId": definition.item_id,
        "amount": shipped,
        "sequence": sequence,
        "firstDeliveredAtMs": clock,
        "lastDeliveredAtMs": clock,
    });
    activity
        .get_mut("pendingBatches")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native pending export batches are missing"))?
        .insert(definition.item_id.to_owned(), batch);
    Ok(())
}

fn record_delivery(
    endgame: &mut Map<String, Value>,
    definition: Definition,
    amount: f64,
    activity_eligible: bool,
) -> anyhow::Result<()> {
    let shipped = amount.floor().max(0.0);
    if shipped < 1.0 {
        return Ok(());
    }
    {
        let project = project(endgame, definition.id)?;
        for key in ["delivered", "totalDelivered"] {
            let current = finite_number(project.get(key));
            set_number(project, key, current + shipped)?;
        }
    }
    for key in ["totalExported", "exportWindowAmount"] {
        let current = finite_number(endgame.get(key));
        set_number(endgame, key, current + shipped)?;
    }
    let earned = shipped * definition.credits_per_item;
    for key in ["galacticCredits", "galacticScore"] {
        let current = finite_number(endgame.get(key));
        set_number(endgame, key, (current + earned).floor())?;
    }
    complete_levels(endgame, definition)?;
    if activity_eligible {
        record_activity_delivery(endgame, definition, shipped)?;
    }
    Ok(())
}

fn certified_counter_value(value: Option<&Value>, label: &str) -> anyhow::Result<i128> {
    let value = value.ok_or_else(|| anyhow!("{label} is missing"))?;
    if let Some(value) = value.as_u64() {
        if value <= MAX_SAFE_INTEGER as u64 {
            return Ok(value as i128);
        }
        bail!("{label} exceeds the JavaScript safe-integer range");
    }
    if let Some(value) = value.as_i64() {
        if value >= 0 {
            return Ok(value as i128);
        }
        bail!("{label} is negative");
    }
    let value = value
        .as_f64()
        .filter(|value| {
            value.is_finite()
                && (0.0..=MAX_SAFE_INTEGER as f64).contains(value)
                && value.fract() == 0.0
        })
        .ok_or_else(|| anyhow!("{label} is not a non-negative safe integer"))?;
    Ok(value as i128)
}

fn certified_counter(object: &Map<String, Value>, key: &str, label: &str) -> anyhow::Result<i128> {
    certified_counter_value(object.get(key), label)
}

fn certified_finite_bits(
    object: &Map<String, Value>,
    key: &str,
    label: &str,
) -> anyhow::Result<u64> {
    let value = object
        .get(key)
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && (0.0..=MAX_SAFE_INTEGER as f64).contains(value))
        .ok_or_else(|| anyhow!("{label} is not a finite non-negative number"))?;
    Ok(if value == 0.0 {
        0.0_f64.to_bits()
    } else {
        value.to_bits()
    })
}

fn certified_optional_text(
    object: &Map<String, Value>,
    key: &str,
    label: &str,
) -> anyhow::Result<Option<String>> {
    match object
        .get(key)
        .ok_or_else(|| anyhow!("{label} is missing"))?
    {
        Value::Null => Ok(None),
        Value::String(value) if !value.is_empty() => Ok(Some(value.clone())),
        _ => bail!("{label} is not null or a non-empty string"),
    }
}

fn capture_certified_activity_endpoint(
    endgame: &Map<String, Value>,
) -> anyhow::Result<CertifiedPureIdleExportActivityEndpoint> {
    let activity = endgame
        .get("constructionActivity")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native certified export construction activity is missing"))?;
    let activity_id = certified_optional_text(
        activity,
        "activityId",
        "endgame.constructionActivity.activityId",
    )?;
    let participant_id = certified_optional_text(
        activity,
        "participantId",
        "endgame.constructionActivity.participantId",
    )?;
    let config_revision = certified_optional_text(
        activity,
        "configRevision",
        "endgame.constructionActivity.configRevision",
    )?;
    if activity_id.is_some() != participant_id.is_some() {
        bail!("native certified export activity identity is incomplete");
    }
    let starts_at_ms = certified_counter(
        activity,
        "startsAtMs",
        "endgame.constructionActivity.startsAtMs",
    )?;
    let ends_at_ms = certified_counter(
        activity,
        "endsAtMs",
        "endgame.constructionActivity.endsAtMs",
    )?;
    let server_time_anchor_ms = certified_counter(
        activity,
        "serverTimeAnchorMs",
        "endgame.constructionActivity.serverTimeAnchorMs",
    )?;
    let activity_clock_ms = certified_counter(
        activity,
        "activityClockMs",
        "endgame.constructionActivity.activityClockMs",
    )?;
    if activity_id.is_some() && ends_at_ms <= starts_at_ms {
        bail!("native certified export activity has an empty time interval");
    }
    if activity_clock_ms < server_time_anchor_ms {
        bail!("native certified export activity clock precedes its server anchor");
    }
    let phase = match activity_id.as_ref() {
        None => CertifiedPureIdleExportActivityPhase::Inactive,
        Some(_) if activity_clock_ms < starts_at_ms => {
            CertifiedPureIdleExportActivityPhase::Scheduled
        }
        Some(_) if activity_clock_ms < ends_at_ms => CertifiedPureIdleExportActivityPhase::Active,
        Some(_) => CertifiedPureIdleExportActivityPhase::Ended,
    };
    let millis_until_boundary = match phase {
        CertifiedPureIdleExportActivityPhase::Scheduled => starts_at_ms - activity_clock_ms,
        CertifiedPureIdleExportActivityPhase::Active => ends_at_ms - activity_clock_ms,
        CertifiedPureIdleExportActivityPhase::Inactive
        | CertifiedPureIdleExportActivityPhase::Ended => 0,
    };

    let personal = activity
        .get("personalDelivered")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native certified export personal delivery mirror is missing"))?;
    let personal_delivered = DEFINITIONS
        .iter()
        .map(|definition| {
            certified_counter_value(
                personal.get(definition.item_id),
                &format!(
                    "endgame.constructionActivity.personalDelivered.{}",
                    definition.item_id
                ),
            )
            .map(|amount| (definition.item_id.to_owned(), amount))
        })
        .collect::<anyhow::Result<BTreeMap<_, _>>>()?;

    let next_batch_sequence = certified_counter(
        activity,
        "nextBatchSequence",
        "endgame.constructionActivity.nextBatchSequence",
    )?;
    let batches = activity
        .get("pendingBatches")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native certified export pending activity batches are missing"))?;
    if batches.keys().any(|item_id| {
        !DEFINITIONS
            .iter()
            .any(|definition| definition.item_id == item_id)
    }) {
        bail!("native certified export pending activity batches contain an unknown material");
    }
    let mut pending_batches = BTreeMap::new();
    for definition in DEFINITIONS {
        let Some(batch) = batches.get(definition.item_id) else {
            continue;
        };
        let batch = batch.as_object().ok_or_else(|| {
            anyhow!(
                "endgame.constructionActivity.pendingBatches.{} is invalid",
                definition.item_id
            )
        })?;
        let id = batch
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| {
                anyhow!(
                    "endgame.constructionActivity.pendingBatches.{}.id is invalid",
                    definition.item_id
                )
            })?
            .to_owned();
        if batch.get("itemId").and_then(Value::as_str) != Some(definition.item_id) {
            bail!(
                "endgame.constructionActivity.pendingBatches.{}.itemId is invalid",
                definition.item_id
            );
        }
        let label = format!(
            "endgame.constructionActivity.pendingBatches.{}",
            definition.item_id
        );
        let amount = certified_counter(batch, "amount", &format!("{label}.amount"))?;
        let sequence = certified_counter(batch, "sequence", &format!("{label}.sequence"))?;
        let first_delivered_at_ms = certified_counter(
            batch,
            "firstDeliveredAtMs",
            &format!("{label}.firstDeliveredAtMs"),
        )?;
        let last_delivered_at_ms = certified_counter(
            batch,
            "lastDeliveredAtMs",
            &format!("{label}.lastDeliveredAtMs"),
        )?;
        if sequence >= next_batch_sequence
            || first_delivered_at_ms > last_delivered_at_ms
            || last_delivered_at_ms > activity_clock_ms
        {
            bail!("{label} is outside the certified sequence or activity clock");
        }
        pending_batches.insert(
            definition.item_id.to_owned(),
            CertifiedPureIdleExportBatchEndpoint {
                id,
                item_id: definition.item_id.to_owned(),
                amount,
                sequence,
                first_delivered_at_ms,
                last_delivered_at_ms,
            },
        );
    }
    if activity_id.is_none() && !pending_batches.is_empty() {
        bail!("native certified export inactive activity retains pending batches");
    }

    Ok(CertifiedPureIdleExportActivityEndpoint {
        activity_id,
        participant_id,
        config_revision,
        starts_at_ms,
        ends_at_ms,
        server_time_anchor_ms,
        activity_clock_ms,
        phase,
        millis_until_boundary,
        personal_delivered,
        pending_batches,
        next_batch_sequence,
    })
}

fn capture_certified_export_endpoint_from_parts(
    base: &Map<String, Value>,
    endgame: &Map<String, Value>,
) -> anyhow::Result<CertifiedPureIdleExportEndpoint> {
    let input_mode = match endgame.get("exportInputMode").and_then(Value::as_str) {
        Some("building") => CertifiedPureIdleExportInputMode::Building,
        Some("legacy-network") => CertifiedPureIdleExportInputMode::LegacyNetwork,
        _ => bail!("native certified export input mode is invalid"),
    };
    let auto_dispatch = endgame
        .get("autoDispatch")
        .and_then(Value::as_bool)
        .ok_or_else(|| anyhow!("native certified export auto-dispatch flag is invalid"))?;
    let dispatch_throttle_bits =
        certified_finite_bits(endgame, "dispatchThrottle", "endgame.dispatchThrottle")?;
    if !matches!(f64::from_bits(dispatch_throttle_bits), 0.25 | 0.5 | 1.0) {
        bail!("native certified export dispatch throttle is unsupported");
    }
    let galactic_logistics_level = endgame
        .get("infiniteResearch")
        .and_then(Value::as_object)
        .and_then(|research| research.get("galactic_logistics"))
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native certified galactic logistics research is missing"))
        .and_then(|progress| {
            certified_counter(
                progress,
                "level",
                "endgame.infiniteResearch.galactic_logistics.level",
            )
        })?;
    let projects = endgame
        .get("exportProjects")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native certified export projects are missing"))?;
    let mut project_endpoints = BTreeMap::new();
    for definition in DEFINITIONS {
        let project = projects
            .get(definition.id)
            .and_then(Value::as_object)
            .ok_or_else(|| {
                anyhow!(
                    "native certified export project {} is missing",
                    definition.id
                )
            })?;
        if project.get("id").and_then(Value::as_str) != Some(definition.id) {
            bail!(
                "native certified export project {} has the wrong ID",
                definition.id
            );
        }
        let enabled = project
            .get("enabled")
            .and_then(Value::as_bool)
            .ok_or_else(|| {
                anyhow!(
                    "native certified export project {} enabled flag is invalid",
                    definition.id
                )
            })?;
        let priority = certified_counter(
            project,
            "priority",
            &format!("endgame.exportProjects.{}.priority", definition.id),
        )?;
        let priority = u8::try_from(priority)
            .ok()
            .filter(|priority| (1..=3).contains(priority))
            .ok_or_else(|| {
                anyhow!(
                    "native certified export project {} priority is invalid",
                    definition.id
                )
            })?;
        let level = certified_counter(
            project,
            "level",
            &format!("endgame.exportProjects.{}.level", definition.id),
        )?;
        let delivered = certified_counter(
            project,
            "delivered",
            &format!("endgame.exportProjects.{}.delivered", definition.id),
        )?;
        let total_delivered = certified_counter(
            project,
            "totalDelivered",
            &format!("endgame.exportProjects.{}.totalDelivered", definition.id),
        )?;
        if total_delivered < delivered {
            bail!(
                "native certified export project {} total is below current-level delivery",
                definition.id
            );
        }
        let level_target = target(definition, level as f64) as i128;
        if delivered >= level_target {
            bail!(
                "native certified export project {} has an unsettled level reward boundary",
                definition.id
            );
        }
        project_endpoints.insert(
            definition.id.to_owned(),
            CertifiedPureIdleExportProjectEndpoint {
                project_id: definition.id.to_owned(),
                item_id: definition.item_id.to_owned(),
                enabled,
                priority,
                level,
                delivered,
                total_delivered,
                dispatch_progress_bits: certified_finite_bits(
                    project,
                    "dispatchProgress",
                    &format!("endgame.exportProjects.{}.dispatchProgress", definition.id),
                )?,
                units_until_level_reward: level_target - delivered,
            },
        );
    }

    Ok(CertifiedPureIdleExportEndpoint {
        endgame_unlocked: completed_tech(base, "universe_matrix"),
        input_mode,
        auto_dispatch,
        dispatch_throttle_bits,
        galactic_logistics_level,
        projects: project_endpoints,
        galactic_credits: certified_counter(endgame, "galacticCredits", "endgame.galacticCredits")?,
        galactic_score: certified_counter(endgame, "galacticScore", "endgame.galacticScore")?,
        total_exported: certified_counter(endgame, "totalExported", "endgame.totalExported")?,
        exported_last_minute_bits: certified_finite_bits(
            endgame,
            "exportedLastMinute",
            "endgame.exportedLastMinute",
        )?,
        export_window_amount: certified_counter(
            endgame,
            "exportWindowAmount",
            "endgame.exportWindowAmount",
        )?,
        export_window_started_at_bits: certified_finite_bits(
            endgame,
            "exportWindowStartedAt",
            "endgame.exportWindowStartedAt",
        )?,
        activity: capture_certified_activity_endpoint(endgame)?,
    })
}

/// Captures only the terminal endpoint/configuration required by a three-window
/// pure-idle certificate. The snapshot is exact and `Eq`; it performs no
/// entity decode and cannot observe or claim starting inventory.
pub(crate) fn capture_certified_pure_idle_export_endpoint(
    base: &Map<String, Value>,
) -> anyhow::Result<CertifiedPureIdleExportEndpoint> {
    let endgame = base
        .get("endgame")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native certified galactic endgame state is missing"))?;
    capture_certified_export_endpoint_from_parts(base, endgame)
}

fn checked_endpoint_delta(after: i128, before: i128, label: &str) -> anyhow::Result<i128> {
    after
        .checked_sub(before)
        .filter(|delta| *delta >= 0)
        .ok_or_else(|| anyhow!("native certified export {label} decreased or overflowed"))
}

fn completed_level_totals(
    definition: Definition,
    level_before: i128,
    level_after: i128,
) -> anyhow::Result<(i128, i128)> {
    if level_after < level_before {
        bail!("native certified export project level decreased");
    }
    let mut remaining = level_after - level_before;
    let mut level = level_before;
    let mut material = 0_i128;
    let mut rewards = 0_i128;
    while remaining > 0 {
        let level_target = target(definition, level as f64) as i128;
        if level_target == 2_000_000_000 {
            let completed_material = level_target
                .checked_mul(remaining)
                .ok_or_else(|| anyhow!("native certified export level material overflowed"))?;
            let completed_rewards = completed_material
                .checked_mul(definition.credits_per_item as i128)
                .ok_or_else(|| anyhow!("native certified export level reward overflowed"))?;
            material = material
                .checked_add(completed_material)
                .ok_or_else(|| anyhow!("native certified export level material overflowed"))?;
            rewards = rewards
                .checked_add(completed_rewards)
                .ok_or_else(|| anyhow!("native certified export level reward overflowed"))?;
            break;
        }
        material = material
            .checked_add(level_target)
            .ok_or_else(|| anyhow!("native certified export level material overflowed"))?;
        rewards = rewards
            .checked_add(
                level_target
                    .checked_mul(definition.credits_per_item as i128)
                    .ok_or_else(|| anyhow!("native certified export level reward overflowed"))?,
            )
            .ok_or_else(|| anyhow!("native certified export level reward overflowed"))?;
        remaining -= 1;
        level += 1;
    }
    Ok((material, rewards))
}

/// Computes the physical terminal flow between two exact endpoints. Project
/// `totalDelivered` is the sole material sink. Activity personal totals and
/// pending batches must move together, may never exceed the physical sink and
/// are returned only as non-owned reporting mirrors.
pub(crate) fn delta_certified_pure_idle_export_endpoints(
    before: &CertifiedPureIdleExportEndpoint,
    after: &CertifiedPureIdleExportEndpoint,
) -> anyhow::Result<CertifiedPureIdleExportEndpointDelta> {
    if before.endgame_unlocked != after.endgame_unlocked
        || before.input_mode != after.input_mode
        || before.auto_dispatch != after.auto_dispatch
        || before.dispatch_throttle_bits != after.dispatch_throttle_bits
        || before.galactic_logistics_level != after.galactic_logistics_level
    {
        bail!("native certified export configuration changed between endpoints");
    }
    let before_activity = &before.activity;
    let after_activity = &after.activity;
    if before_activity.activity_id != after_activity.activity_id
        || before_activity.participant_id != after_activity.participant_id
        || before_activity.config_revision != after_activity.config_revision
        || before_activity.starts_at_ms != after_activity.starts_at_ms
        || before_activity.ends_at_ms != after_activity.ends_at_ms
        || before_activity.server_time_anchor_ms != after_activity.server_time_anchor_ms
    {
        bail!("native certified export activity identity or boundary changed");
    }
    let activity_clock_advanced_ms = checked_endpoint_delta(
        after_activity.activity_clock_ms,
        before_activity.activity_clock_ms,
        "activity clock",
    )?;

    let mut physical_consumed_by_item = BTreeMap::new();
    let mut level_boundaries = BTreeMap::new();
    let mut expected_reward = 0_i128;
    let mut physical_total = 0_i128;
    for definition in DEFINITIONS {
        let project_before = before
            .projects
            .get(definition.id)
            .ok_or_else(|| anyhow!("native certified export before project disappeared"))?;
        let project_after = after
            .projects
            .get(definition.id)
            .ok_or_else(|| anyhow!("native certified export after project disappeared"))?;
        if project_before.project_id != project_after.project_id
            || project_before.item_id != project_after.item_id
            || project_before.enabled != project_after.enabled
            || project_before.priority != project_after.priority
            || project_before.dispatch_progress_bits != project_after.dispatch_progress_bits
        {
            bail!("native certified export project configuration changed");
        }
        let physical = checked_endpoint_delta(
            project_after.total_delivered,
            project_before.total_delivered,
            &format!("{} physical delivery", definition.item_id),
        )?;
        let (completed_material, completed_rewards) =
            completed_level_totals(definition, project_before.level, project_after.level)?;
        let left = project_before
            .delivered
            .checked_add(physical)
            .ok_or_else(|| anyhow!("native certified export project material overflowed"))?;
        let right = project_after
            .delivered
            .checked_add(completed_material)
            .ok_or_else(|| anyhow!("native certified export project material overflowed"))?;
        if left != right {
            bail!(
                "native certified export project {} level ledger does not close",
                definition.id
            );
        }
        let base_reward = physical
            .checked_mul(definition.credits_per_item as i128)
            .ok_or_else(|| anyhow!("native certified export base reward overflowed"))?;
        expected_reward = expected_reward
            .checked_add(base_reward)
            .and_then(|reward| reward.checked_add(completed_rewards))
            .ok_or_else(|| anyhow!("native certified export aggregate reward overflowed"))?;
        physical_total = physical_total
            .checked_add(physical)
            .ok_or_else(|| anyhow!("native certified export physical total overflowed"))?;
        physical_consumed_by_item.insert(definition.item_id.to_owned(), physical);
        level_boundaries.insert(
            definition.item_id.to_owned(),
            CertifiedPureIdleExportLevelBoundary {
                project_id: definition.id.to_owned(),
                level_before: project_before.level,
                level_after: project_after.level,
                delivered_before: project_before.delivered,
                delivered_after: project_after.delivered,
                units_until_level_reward_before: project_before.units_until_level_reward,
                units_until_level_reward_after: project_after.units_until_level_reward,
            },
        );
    }
    let total_exported =
        checked_endpoint_delta(after.total_exported, before.total_exported, "global total")?;
    if total_exported != physical_total {
        bail!("native certified export global total does not match project physical delivery");
    }
    let reward_credits = checked_endpoint_delta(
        after.galactic_credits,
        before.galactic_credits,
        "credit reward",
    )?;
    let reward_score =
        checked_endpoint_delta(after.galactic_score, before.galactic_score, "score reward")?;
    if reward_credits != expected_reward || reward_score != expected_reward {
        bail!("native certified export reward ledger does not match physical delivery");
    }

    let mut activity_personal_mirror_by_item = BTreeMap::new();
    let mut activity_pending_mirror_by_item = BTreeMap::new();
    let mut created_batch_sequences = Vec::new();
    for definition in DEFINITIONS {
        let personal = checked_endpoint_delta(
            after_activity.personal_delivered[definition.item_id],
            before_activity.personal_delivered[definition.item_id],
            &format!("{} activity personal mirror", definition.item_id),
        )?;
        let batch_before = before_activity.pending_batches.get(definition.item_id);
        let batch_after = after_activity.pending_batches.get(definition.item_id);
        let pending = match (batch_before, batch_after) {
            (None, None) => 0,
            (None, Some(batch)) => {
                if batch.sequence < before_activity.next_batch_sequence {
                    bail!("native certified export created activity batch sequence is stale");
                }
                created_batch_sequences.push(batch.sequence);
                batch.amount
            }
            (Some(_), None) => {
                bail!("native certified export activity batch disappeared between endpoints")
            }
            (Some(before_batch), Some(after_batch)) => {
                if before_batch.id != after_batch.id
                    || before_batch.item_id != after_batch.item_id
                    || before_batch.sequence != after_batch.sequence
                    || before_batch.first_delivered_at_ms != after_batch.first_delivered_at_ms
                    || after_batch.last_delivered_at_ms < before_batch.last_delivered_at_ms
                {
                    bail!("native certified export activity batch identity changed");
                }
                checked_endpoint_delta(
                    after_batch.amount,
                    before_batch.amount,
                    &format!("{} activity pending mirror", definition.item_id),
                )?
            }
        };
        let physical = physical_consumed_by_item[definition.item_id];
        if personal != pending || personal > physical {
            bail!(
                "native certified export activity mirror for {} does not close against physical delivery",
                definition.item_id
            );
        }
        activity_personal_mirror_by_item.insert(definition.item_id.to_owned(), personal);
        activity_pending_mirror_by_item.insert(definition.item_id.to_owned(), pending);
    }
    let mirrored_total = activity_personal_mirror_by_item
        .values()
        .try_fold(0_i128, |total, amount| total.checked_add(*amount))
        .ok_or_else(|| anyhow!("native certified export activity mirror total overflowed"))?;
    if physical_total > 0 {
        if before.input_mode != CertifiedPureIdleExportInputMode::Building
            || before_activity.phase != CertifiedPureIdleExportActivityPhase::Active
            || !(after_activity.phase == CertifiedPureIdleExportActivityPhase::Active
                || after_activity.phase == CertifiedPureIdleExportActivityPhase::Ended
                    && after_activity.activity_clock_ms == after_activity.ends_at_ms)
        {
            bail!(
                "native certified export physical delivery is not an activity-bounded building terminal"
            );
        }
        if mirrored_total != physical_total
            || DEFINITIONS.iter().any(|definition| {
                activity_personal_mirror_by_item[definition.item_id]
                    != physical_consumed_by_item[definition.item_id]
            })
        {
            bail!("native certified export activity mirrors do not equal physical delivery");
        }
        for definition in DEFINITIONS {
            if physical_consumed_by_item[definition.item_id] < 1 {
                continue;
            }
            let batch = after_activity
                .pending_batches
                .get(definition.item_id)
                .ok_or_else(|| {
                    anyhow!("native certified export activity mirror batch is missing")
                })?;
            if batch.last_delivered_at_ms < before_activity.activity_clock_ms
                || batch.last_delivered_at_ms >= after_activity.ends_at_ms
            {
                bail!("native certified export activity delivery crossed its half-open boundary");
            }
        }
    } else if mirrored_total != 0 {
        bail!("native certified export activity mirror advanced without physical delivery");
    }
    created_batch_sequences.sort_unstable();
    created_batch_sequences.dedup();
    let created_count = i128::try_from(created_batch_sequences.len())
        .map_err(|_| anyhow!("native certified export activity batch count overflowed"))?;
    let expected_next_sequence = before_activity
        .next_batch_sequence
        .checked_add(created_count)
        .ok_or_else(|| anyhow!("native certified export activity sequence overflowed"))?;
    if after_activity.next_batch_sequence != expected_next_sequence
        || created_batch_sequences
            .iter()
            .enumerate()
            .any(|(offset, sequence)| {
                *sequence != before_activity.next_batch_sequence + offset as i128
            })
    {
        bail!("native certified export activity batch sequence is not contiguous");
    }
    Ok(CertifiedPureIdleExportEndpointDelta {
        physical_consumed_by_item,
        activity_personal_mirror_by_item,
        activity_pending_mirror_by_item,
        reward_credits,
        reward_score,
        total_exported,
        activity_clock_advanced_ms,
        level_boundaries,
        pending_activity_batches_are_owned_inventory: false,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CertifiedExportBudgetProbe {
    definition_index: usize,
    requested: i128,
}

fn ordered_certified_export_budget_probes_with_runtime(
    runtime: &DeterministicRuntime,
    endpoint: &CertifiedPureIdleExportEndpoint,
    newly_produced_budgets: &BTreeMap<String, i128>,
) -> anyhow::Result<Vec<CertifiedExportBudgetProbe>> {
    for (item_id, amount) in newly_produced_budgets {
        if !(0..=MAX_SAFE_INTEGER).contains(amount) {
            bail!("native certified export budget {item_id} is outside the safe-integer range");
        }
    }
    let definition_indices = [0_usize, 1, 2, 3];
    let mut probes = runtime.indexed_map(&definition_indices, |_, definition_index| {
        let definition = DEFINITIONS[*definition_index];
        CertifiedExportBudgetProbe {
            definition_index: *definition_index,
            requested: newly_produced_budgets
                .get(definition.item_id)
                .copied()
                .unwrap_or(0),
        }
    });
    probes.sort_by(|left, right| {
        let left_definition = DEFINITIONS[left.definition_index];
        let right_definition = DEFINITIONS[right.definition_index];
        let priority = |definition: Definition| endpoint.projects[definition.id].priority;
        priority(right_definition)
            .cmp(&priority(left_definition))
            .then_with(|| left_definition.item_id.cmp(right_definition.item_id))
    });
    Ok(probes)
}

fn certified_delivery_counter_capacity(
    endpoint: &CertifiedPureIdleExportEndpoint,
    definition: Definition,
    activity_eligible: bool,
) -> i128 {
    let project = &endpoint.projects[definition.id];
    let reward_per_item = definition.credits_per_item as i128;
    let mut capacity = MAX_SAFE_INTEGER
        .saturating_sub(project.total_delivered)
        .min(MAX_SAFE_INTEGER.saturating_sub(endpoint.total_exported))
        .min(MAX_SAFE_INTEGER.saturating_sub(endpoint.galactic_credits) / reward_per_item)
        .min(MAX_SAFE_INTEGER.saturating_sub(endpoint.galactic_score) / reward_per_item);
    if activity_eligible {
        capacity = capacity.min(
            MAX_SAFE_INTEGER
                .saturating_sub(endpoint.activity.personal_delivered[definition.item_id]),
        );
        if let Some(batch) = endpoint.activity.pending_batches.get(definition.item_id) {
            capacity = capacity.min(MAX_SAFE_INTEGER.saturating_sub(batch.amount));
        } else if endpoint.activity.next_batch_sequence >= MAX_SAFE_INTEGER {
            capacity = 0;
        }
    }
    capacity.max(0)
}

/// Compute one shared whole-second horizon for the complete certified rate
/// vector. Global counters are divided by their aggregate per-second demand;
/// calculating them item-by-item would incorrectly authorize the same final
/// safe-integer slots more than once when several projects run together.
pub(crate) fn certified_pure_idle_export_capacity_seconds(
    endpoint: &CertifiedPureIdleExportEndpoint,
    rates_by_item: &BTreeMap<String, i128>,
) -> anyhow::Result<i128> {
    let mut horizon = i128::MAX;
    let mut aggregate_items_per_second = 0_i128;
    let mut aggregate_rewards_per_second = 0_i128;
    let activity_eligible = endpoint.input_mode == CertifiedPureIdleExportInputMode::Building
        && endpoint.activity.phase == CertifiedPureIdleExportActivityPhase::Active;
    let mut new_activity_batches = 0_i128;

    for (item_id, rate) in rates_by_item {
        if *rate <= 0 {
            bail!("native certified export rate is not positive")
        }
        let definition = DEFINITIONS
            .iter()
            .copied()
            .find(|definition| definition.item_id == item_id)
            .ok_or_else(|| anyhow!("native certified export item is unsupported"))?;
        let project = endpoint
            .projects
            .get(definition.id)
            .ok_or_else(|| anyhow!("native certified export project disappeared"))?;
        horizon = horizon
            .min(project.units_until_level_reward.saturating_sub(1) / rate)
            .min(MAX_SAFE_INTEGER.saturating_sub(project.total_delivered) / rate);
        aggregate_items_per_second = aggregate_items_per_second
            .checked_add(*rate)
            .ok_or_else(|| anyhow!("native certified export aggregate rate overflowed"))?;
        aggregate_rewards_per_second = aggregate_rewards_per_second
            .checked_add(
                rate.checked_mul(definition.credits_per_item as i128)
                    .ok_or_else(|| anyhow!("native certified export reward rate overflowed"))?,
            )
            .ok_or_else(|| anyhow!("native certified export reward rate overflowed"))?;
        if activity_eligible {
            let personal = endpoint
                .activity
                .personal_delivered
                .get(item_id)
                .copied()
                .unwrap_or(0);
            horizon = horizon.min(MAX_SAFE_INTEGER.saturating_sub(personal) / rate);
            if let Some(batch) = endpoint.activity.pending_batches.get(item_id) {
                horizon = horizon.min(MAX_SAFE_INTEGER.saturating_sub(batch.amount) / rate);
            } else {
                new_activity_batches = new_activity_batches.saturating_add(1);
            }
        }
    }
    if aggregate_items_per_second > 0 {
        horizon = horizon.min(
            MAX_SAFE_INTEGER.saturating_sub(endpoint.total_exported) / aggregate_items_per_second,
        );
    }
    if aggregate_rewards_per_second > 0 {
        horizon = horizon
            .min(
                MAX_SAFE_INTEGER.saturating_sub(endpoint.galactic_credits)
                    / aggregate_rewards_per_second,
            )
            .min(
                MAX_SAFE_INTEGER.saturating_sub(endpoint.galactic_score)
                    / aggregate_rewards_per_second,
            );
    }
    if activity_eligible
        && new_activity_batches
            > MAX_SAFE_INTEGER.saturating_sub(endpoint.activity.next_batch_sequence)
    {
        horizon = 0;
    }
    Ok(horizon.max(0))
}

/// Atomically spends only caller-certified, newly-produced export budgets.
///
/// The current endpoint must exactly match `expected`; no tray, entity,
/// in-flight, logistics or quantum stock is inspected. Each project stops one
/// unit before its first level/reward boundary. That deliberate under-credit
/// keeps long and segmented pure-idle calls equivalent without replaying a
/// reward that could change downstream production.
pub(crate) fn apply_certified_pure_idle_export_budget(
    base: &mut Map<String, Value>,
    expected: &CertifiedPureIdleExportEndpoint,
    newly_produced_budgets: &BTreeMap<String, i128>,
    activity_clock_after_ms: i128,
    last_delivery_at_ms: i128,
) -> anyhow::Result<CertifiedPureIdleExportReceipt> {
    let current = capture_certified_pure_idle_export_endpoint(base)?;
    if &current != expected {
        bail!("native certified export endpoint diverged before commit");
    }
    let probes = ordered_certified_export_budget_probes_with_runtime(
        deterministic_runtime(),
        expected,
        newly_produced_budgets,
    )?;
    let has_requested_export = probes.iter().any(|probe| probe.requested > 0);
    if has_requested_export && !expected.endgame_unlocked {
        bail!("native certified export terminal is not unlocked");
    }
    let activity_eligible = match expected.input_mode {
        CertifiedPureIdleExportInputMode::Building => {
            if has_requested_export
                && expected.activity.phase != CertifiedPureIdleExportActivityPhase::Active
            {
                bail!("native certified building export is outside its activity boundary");
            }
            if expected.auto_dispatch {
                bail!("native certified building export requires legacy auto-dispatch to be off");
            }
            expected.activity.phase == CertifiedPureIdleExportActivityPhase::Active
        }
        CertifiedPureIdleExportInputMode::LegacyNetwork => {
            if has_requested_export {
                bail!("native certified pure-idle export forbids legacy network dispatch");
            }
            false
        }
    };
    let activity_clock_valid = (expected.activity.activity_clock_ms..=expected.activity.ends_at_ms)
        .contains(&activity_clock_after_ms)
        && activity_clock_after_ms <= MAX_SAFE_INTEGER;
    let delivery_clock_valid = if has_requested_export {
        (expected.activity.activity_clock_ms..=activity_clock_after_ms)
            .contains(&last_delivery_at_ms)
            && last_delivery_at_ms < expected.activity.ends_at_ms
    } else {
        // Empty-budget calls advance only the public activity clock. The
        // sentinel proves no pending-batch delivery timestamp may move.
        last_delivery_at_ms == expected.activity.activity_clock_ms
    };
    if !activity_clock_valid || !delivery_clock_valid {
        bail!("native certified export activity clock request crosses its safe boundary");
    }

    let mut candidate = base
        .get("endgame")
        .and_then(Value::as_object)
        .cloned()
        .ok_or_else(|| anyhow!("native certified galactic endgame state is missing"))?;
    let frozen_export_telemetry = [
        "exportedLastMinute",
        "exportWindowAmount",
        "exportWindowStartedAt",
    ]
    .map(|key| {
        candidate
            .get(key)
            .cloned()
            .ok_or_else(|| anyhow!("native certified export telemetry {key} is missing"))
            .map(|value| (key, value))
    })
    .into_iter()
    .collect::<anyhow::Result<Vec<_>>>()?;
    let mut requested_by_item = BTreeMap::new();
    let mut items = BTreeMap::new();
    let mut clipped = false;
    let mut any_boundary_limited = false;

    for probe in probes {
        let definition = DEFINITIONS[probe.definition_index];
        let requested = probe.requested;
        if requested < 1 {
            continue;
        }
        requested_by_item.insert(definition.item_id.to_owned(), requested);
        let endpoint_before = capture_certified_export_endpoint_from_parts(base, &candidate)?;
        let project_before = &endpoint_before.projects[definition.id];
        let configuration_eligible =
            endpoint_before.input_mode == CertifiedPureIdleExportInputMode::Building;
        let boundary_capacity = project_before.units_until_level_reward.saturating_sub(1);
        let counter_capacity =
            certified_delivery_counter_capacity(&endpoint_before, definition, activity_eligible);
        let consumed = if configuration_eligible {
            requested.min(boundary_capacity).min(counter_capacity)
        } else {
            0
        };
        let boundary_limited = requested > boundary_capacity;
        let counter_limited =
            configuration_eligible && requested.min(boundary_capacity) > counter_capacity;
        let configuration_limited = !configuration_eligible;
        if consumed > 0 {
            record_delivery(
                &mut candidate,
                definition,
                consumed as f64,
                activity_eligible,
            )?;
        }
        let endpoint_after = capture_certified_export_endpoint_from_parts(base, &candidate)?;
        let delta = delta_certified_pure_idle_export_endpoints(&endpoint_before, &endpoint_after)?;
        if delta.physical_consumed_by_item[definition.item_id] != consumed
            || delta
                .physical_consumed_by_item
                .iter()
                .any(|(item_id, amount)| item_id != definition.item_id && *amount != 0)
        {
            bail!("native certified export item receipt does not match its physical commit");
        }
        let project_after = &endpoint_after.projects[definition.id];
        let reward_credits = consumed
            .checked_mul(definition.credits_per_item as i128)
            .ok_or_else(|| anyhow!("native certified export item reward overflowed"))?;
        items.insert(
            definition.item_id.to_owned(),
            CertifiedPureIdleExportItemReceipt {
                project_id: definition.id.to_owned(),
                requested_budget: requested,
                consumed,
                unconsumed_budget: requested - consumed,
                reward_credits,
                reward_score: reward_credits,
                level_before: project_before.level,
                level_after: project_after.level,
                units_until_level_reward_before: project_before.units_until_level_reward,
                units_until_level_reward_after: project_after.units_until_level_reward,
                boundary_limited,
                counter_limited,
                configuration_limited,
            },
        );
        clipped |= consumed != requested;
        any_boundary_limited |= boundary_limited;
    }

    {
        let activity = candidate
            .get_mut("constructionActivity")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native certified export activity disappeared before commit"))?;
        let batches = activity
            .get_mut("pendingBatches")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native certified export activity batches disappeared"))?;
        for (item_id, item) in &items {
            if item.consumed < 1 {
                continue;
            }
            let batch = batches
                .get_mut(item_id)
                .and_then(Value::as_object_mut)
                .ok_or_else(|| anyhow!("native certified export activity batch disappeared"))?;
            set_number(batch, "lastDeliveredAtMs", last_delivery_at_ms as f64)?;
        }
        set_number(activity, "activityClockMs", activity_clock_after_ms as f64)?;
    }
    for (key, value) in frozen_export_telemetry {
        candidate.insert(key.to_owned(), value);
    }

    let endpoint_after = capture_certified_export_endpoint_from_parts(base, &candidate)?;
    let aggregate = delta_certified_pure_idle_export_endpoints(expected, &endpoint_after)?;
    let consumed_by_item = aggregate
        .physical_consumed_by_item
        .iter()
        .filter(|(_, amount)| **amount > 0)
        .map(|(item_id, amount)| (item_id.clone(), *amount))
        .collect::<BTreeMap<_, _>>();
    for (item_id, requested) in &requested_by_item {
        let consumed = aggregate
            .physical_consumed_by_item
            .get(item_id)
            .copied()
            .unwrap_or(0);
        if consumed > *requested {
            bail!("native certified export consumed beyond its new-production budget");
        }
    }
    base.insert("endgame".to_owned(), Value::Object(candidate));
    Ok(CertifiedPureIdleExportReceipt {
        requested_by_item,
        consumed_by_item,
        items,
        reward_credits: aggregate.reward_credits,
        reward_score: aggregate.reward_score,
        activity_personal_mirror_by_item: aggregate.activity_personal_mirror_by_item,
        activity_pending_mirror_by_item: aggregate.activity_pending_mirror_by_item,
        clipped,
        boundary_limited: any_boundary_limited,
        pending_activity_batches_are_owned_inventory: false,
        endpoint_after,
    })
}

fn network_stock(
    state: &CoreState,
    base: &Map<String, Value>,
    entities: &[Value],
    item_id: &str,
) -> f64 {
    let active_planet = base
        .get("activePlanetId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let tray = base.get("tray").and_then(Value::as_object);
    let trays = base.get("planetTrays").and_then(Value::as_object);
    let tray_total = state
        .catalog
        .planets
        .iter()
        .map(|planet| {
            if planet.id == active_planet {
                finite_number(tray.and_then(|tray| tray.get(item_id))).floor()
            } else {
                finite_number(
                    trays
                        .and_then(|trays| trays.get(&planet.id))
                        .and_then(Value::as_object)
                        .and_then(|tray| tray.get(item_id)),
                )
                .floor()
            }
        })
        .sum::<f64>();
    let entity_total = entities
        .iter()
        .filter_map(Value::as_object)
        .map(|entity| {
            finite_number(
                entity
                    .get("outputs")
                    .and_then(Value::as_object)
                    .and_then(|outputs| outputs.get(item_id)),
            )
            .floor()
        })
        .sum::<f64>();
    (tray_total + entity_total).max(0.0)
}

fn withdraw(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entities: &mut [Value],
    item_id: &str,
    amount: f64,
) -> anyhow::Result<f64> {
    let mut remaining = amount.floor().max(0.0);
    let mut withdrawn = 0.0;
    for entity in entities.iter_mut().filter_map(Value::as_object_mut) {
        if remaining < 1.0 {
            break;
        }
        let outputs = entity
            .get_mut("outputs")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native export entity outputs are missing"))?;
        let available = finite_number(outputs.get(item_id)).floor().max(0.0);
        let taken = remaining.min(available);
        if taken < 1.0 {
            continue;
        }
        set_number(outputs, item_id, available - taken)?;
        remaining -= taken;
        withdrawn += taken;
    }
    let active_planet = base
        .get("activePlanetId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("native export active planet is missing"))?
        .to_owned();
    for planet in &state.catalog.planets {
        if remaining < 1.0 {
            break;
        }
        let tray = if planet.id == active_planet {
            base.get_mut("tray")
                .and_then(Value::as_object_mut)
                .ok_or_else(|| anyhow!("native export active tray is missing"))?
        } else {
            base.get_mut("planetTrays")
                .and_then(Value::as_object_mut)
                .and_then(|trays| trays.get_mut(&planet.id))
                .and_then(Value::as_object_mut)
                .ok_or_else(|| anyhow!("native export planet tray is missing"))?
        };
        let available = finite_number(tray.get(item_id)).floor().max(0.0);
        let taken = remaining.min(available);
        if taken < 1.0 {
            continue;
        }
        set_number(tray, item_id, available - taken)?;
        remaining -= taken;
        withdrawn += taken;
    }
    let active_tray = base
        .get("tray")
        .cloned()
        .ok_or_else(|| anyhow!("native export active tray is missing"))?;
    base.get_mut("planetTrays")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native export planet trays are missing"))?
        .insert(active_planet, active_tray);
    Ok(withdrawn)
}

fn dispatch(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entities: &mut [Value],
    endgame: &mut Map<String, Value>,
    definition: Definition,
    requested: f64,
) -> anyhow::Result<f64> {
    if !completed_tech(base, "universe_matrix") {
        return Ok(0.0);
    }
    let level = finite_number(project(endgame, definition.id)?.get("level"));
    let reserve = (definition.reserve * (1.0 + level * 0.08)).floor();
    let available = (network_stock(state, base, entities, definition.item_id) - reserve).max(0.0);
    let shipped = withdraw(
        state,
        base,
        entities,
        definition.item_id,
        available.min(requested),
    )?;
    if shipped > 0.0 {
        record_delivery(endgame, definition, shipped, false)?;
    }
    Ok(shipped)
}

/// Applies one legacy-network manual dispatch against authoritative stock.
///
/// The semantic command layer deliberately passes only a project ID and a
/// requested upper bound. This helper re-derives reserve, network inventory,
/// physical withdrawals, level completion, credits and activity mirrors from
/// the current Rust state, so neither the renderer nor the WAL can author any
/// material-bearing result.
pub(crate) fn dispatch_manual(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entities: &mut [Value],
    project_id: &str,
    requested: u64,
) -> anyhow::Result<u64> {
    let definition = DEFINITIONS
        .iter()
        .copied()
        .find(|definition| definition.id == project_id)
        .ok_or_else(|| anyhow!("native galactic export project is unknown"))?;
    let mut endgame = base
        .remove("endgame")
        .and_then(|value| value.as_object().cloned())
        .ok_or_else(|| anyhow!("native galactic endgame state is missing"))?;
    if endgame.get("exportInputMode").and_then(Value::as_str) != Some("legacy-network") {
        base.insert("endgame".to_owned(), Value::Object(endgame));
        bail!("native galactic manual dispatch requires legacy network mode")
    }
    let shipped = dispatch(
        state,
        base,
        entities,
        &mut endgame,
        definition,
        requested as f64,
    )?;
    base.insert("endgame".to_owned(), Value::Object(endgame));
    if !shipped.is_finite() || shipped < 0.0 || shipped > MAX_SAFE_INTEGER as f64 {
        bail!("native galactic manual dispatch result is invalid")
    }
    Ok(shipped.floor() as u64)
}

fn workspace_decimal(value: f64) -> String {
    if !value.is_finite() || value <= 0.0 {
        return "0".to_owned();
    }
    if value >= 1e256 {
        return "9".repeat(MAX_WORKSPACE_DECIMAL_DIGITS);
    }
    let text = format!("{:.0}", value.floor());
    if text.len() > MAX_WORKSPACE_DECIMAL_DIGITS {
        "9".repeat(MAX_WORKSPACE_DECIMAL_DIGITS)
    } else {
        text
    }
}

fn workspace_non_negative_number(
    object: &Map<String, Value>,
    key: &str,
    label: &str,
) -> anyhow::Result<f64> {
    object
        .get(key)
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value >= 0.0)
        .ok_or_else(|| anyhow!("native galactic export workspace {label} is invalid"))
}

/// Bounded, game-only management projection for the thin Galaxy workspace.
/// It scans only the four fixed projects and exporter topology indices; it
/// never exposes entity IDs, inventories, trays or activity batch payloads.
pub(crate) fn workspace_projection(state: &CoreState) -> anyhow::Result<Value> {
    let base = state.base_value();
    let endgame = base
        .get("endgame")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native galactic endgame state is missing"))?;
    if admission_reason(state)?.is_some() {
        bail!("native galactic export workspace state is unsupported")
    }
    let input_mode = endgame
        .get("exportInputMode")
        .and_then(Value::as_str)
        .filter(|mode| matches!(*mode, "building" | "legacy-network"))
        .ok_or_else(|| anyhow!("native galactic export workspace mode is invalid"))?;
    let auto_dispatch = endgame
        .get("autoDispatch")
        .and_then(Value::as_bool)
        .ok_or_else(|| anyhow!("native galactic export workspace automation is invalid"))?;
    let throttle = endgame
        .get("dispatchThrottle")
        .and_then(Value::as_f64)
        .filter(|value| matches!(*value, 0.25 | 0.5 | 1.0))
        .ok_or_else(|| anyhow!("native galactic export workspace throttle is invalid"))?;
    let projects = endgame
        .get("exportProjects")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native galactic export workspace projects are missing"))?;
    let mut projected_projects = Vec::with_capacity(DEFINITIONS.len());
    for definition in DEFINITIONS {
        let row = projects
            .get(definition.id)
            .and_then(Value::as_object)
            .ok_or_else(|| anyhow!("native galactic export workspace project is invalid"))?;
        let enabled = row
            .get("enabled")
            .and_then(Value::as_bool)
            .ok_or_else(|| anyhow!("native galactic export workspace project switch is invalid"))?;
        let priority = row
            .get("priority")
            .and_then(Value::as_u64)
            .filter(|value| matches!(*value, 1..=3))
            .ok_or_else(|| anyhow!("native galactic export workspace priority is invalid"))?;
        let level = workspace_non_negative_number(row, "level", "project level")?;
        let delivered = workspace_non_negative_number(row, "delivered", "project delivery")?;
        let total_delivered =
            workspace_non_negative_number(row, "totalDelivered", "project total delivery")?;
        let dispatch_progress =
            workspace_non_negative_number(row, "dispatchProgress", "project progress")?;
        projected_projects.push(serde_json::json!({
            "id": definition.id,
            "itemId": definition.item_id,
            "enabled": enabled,
            "priority": priority,
            "level": workspace_decimal(level),
            "delivered": workspace_decimal(delivered),
            "totalDelivered": workspace_decimal(total_delivered),
            "dispatchProgress": workspace_decimal(dispatch_progress),
            "target": workspace_decimal(target(definition, level)),
            "reserve": workspace_decimal((definition.reserve * (1.0 + level * 0.08)).floor()),
        }));
    }
    let mut paused_exporters = 0_u64;
    for &index in &state.factory_topology.galactic_material_exporter_indices {
        let entity = state.parse_entity(index)?;
        let entity = entity
            .as_object()
            .ok_or_else(|| anyhow!("native galactic exporter projection row is invalid"))?;
        if entity.get("buildingId").and_then(Value::as_str) != Some("galactic_material_exporter") {
            bail!("native galactic exporter topology is inconsistent")
        }
        match entity
            .get("galacticExporterPaused")
            .and_then(Value::as_bool)
        {
            Some(true) => paused_exporters = paused_exporters.saturating_add(1),
            Some(false) => {}
            None => bail!("native galactic exporter pause state is invalid"),
        }
    }
    let exporter_total = u64::try_from(
        state
            .factory_topology
            .galactic_material_exporter_indices
            .len(),
    )
    .unwrap_or(u64::MAX)
    .min(MAX_SAFE_INTEGER as u64);
    let galactic_credits =
        workspace_non_negative_number(endgame, "galacticCredits", "credit counter")?;
    let galactic_score = workspace_non_negative_number(endgame, "galacticScore", "score counter")?;
    let total_exported =
        workspace_non_negative_number(endgame, "totalExported", "total export counter")?;
    let exported_last_minute =
        workspace_non_negative_number(endgame, "exportedLastMinute", "last-minute export counter")?;
    Ok(serde_json::json!({
        "unlocked": completed_tech(base, "universe_matrix"),
        "inputMode": input_mode,
        "autoDispatch": auto_dispatch,
        "dispatchThrottle": throttle,
        "galacticCredits": workspace_decimal(galactic_credits),
        "galacticScore": workspace_decimal(galactic_score),
        "totalExported": workspace_decimal(total_exported),
        "exportedLastMinute": workspace_decimal(exported_last_minute),
        "exporters": {
            "total": exporter_total,
            "paused": paused_exporters,
            "running": exporter_total.saturating_sub(paused_exporters),
        },
        "projects": projected_projects,
    }))
}

fn activity_active(endgame: &Map<String, Value>) -> bool {
    let Some(activity) = endgame
        .get("constructionActivity")
        .and_then(Value::as_object)
    else {
        return false;
    };
    let active = activity
        .get("activityId")
        .and_then(Value::as_str)
        .is_some_and(|id| !id.is_empty());
    let clock = finite_number(activity.get("activityClockMs"));
    active
        && clock >= finite_number(activity.get("startsAtMs"))
        && clock < finite_number(activity.get("endsAtMs"))
}

fn ready_exporter_indices_with_runtime(
    runtime: &DeterministicRuntime,
    state: &CoreState,
    entities: &[Value],
) -> Vec<usize> {
    runtime
        .indexed_map(
            &state.factory_topology.galactic_material_exporter_indices,
            |_, &index| {
                let entity = entities.get(index).and_then(Value::as_object)?;
                (entity
                    .get("galacticExporterPaused")
                    .and_then(Value::as_bool)
                    == Some(false)
                    && DEFINITIONS.iter().any(|definition| {
                        finite_number(
                            entity
                                .get("inputs")
                                .and_then(Value::as_object)
                                .and_then(|inputs| inputs.get(definition.item_id)),
                        ) >= 1.0
                    }))
                .then_some(index)
            },
        )
        .into_iter()
        .flatten()
        .collect()
}

pub(crate) fn ready_exporter_indices(state: &CoreState, entities: &[Value]) -> Vec<usize> {
    ready_exporter_indices_with_runtime(deterministic_runtime(), state, entities)
}

pub(crate) fn operating_blocked(entity: &Map<String, Value>) -> bool {
    if entity
        .get("galacticExporterPaused")
        .and_then(Value::as_bool)
        != Some(false)
    {
        return false;
    }
    let buffered = DEFINITIONS
        .iter()
        .map(|definition| {
            finite_number(
                entity
                    .get("inputs")
                    .and_then(Value::as_object)
                    .and_then(|inputs| inputs.get(definition.item_id)),
            )
            .max(0.0)
        })
        .sum::<f64>();
    buffered >= 1.0 && finite_number(entity.get("powerFactor")) <= EPSILON
}

fn run_with_runtime(
    runtime: &DeterministicRuntime,
    state: &CoreState,
    base: &mut Map<String, Value>,
    entities: &mut [Value],
    effective_power: &HashMap<usize, f64>,
    allocated_power: &HashMap<usize, f64>,
    seconds: f64,
) -> anyhow::Result<()> {
    let mut endgame = base
        .remove("endgame")
        .and_then(|value| value.as_object().cloned())
        .ok_or_else(|| anyhow!("native galactic endgame state is missing"))?;
    let physical_active = activity_active(&endgame);
    let probes = collect_ordered_exporter_probes_with_runtime(
        runtime,
        &state.factory_topology.galactic_material_exporter_indices,
        |entity_index| probe_exporter(entities, effective_power, allocated_power, entity_index),
    )?;
    let mut ordered_definition_indices = [0_usize, 1, 2, 3];
    ordered_definition_indices.sort_by(|left, right| {
        let priority = |definition_index: usize| {
            let definition = DEFINITIONS[definition_index];
            endgame
                .get("exportProjects")
                .and_then(Value::as_object)
                .and_then(|projects| projects.get(definition.id))
                .and_then(Value::as_object)
                .map(|project| finite_number(project.get("priority")))
                .unwrap_or(0.0)
        };
        priority(*right)
            .partial_cmp(&priority(*left))
            .unwrap_or(Ordering::Equal)
            .then_with(|| DEFINITIONS[*left].item_id.cmp(DEFINITIONS[*right].item_id))
    });
    for probe in probes {
        let entity = entities
            .get_mut(probe.entity_index)
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native galactic exporter is invalid"))?;
        if probe.allocated_power {
            set_number(
                entity,
                "powerFactor",
                (probe.power_factor * 10_000.0).round() / 10_000.0,
            )?;
        } else {
            entity.remove("powerFactor");
        }
        set_number(entity, "productionRate", 0.0)?;
        set_number(entity, "utilization", 0.0)?;
        if !physical_active || probe.paused || probe.power_factor <= EPSILON {
            continue;
        }
        let mut delivered = 0.0;
        for definition_index in ordered_definition_indices {
            let definition = DEFINITIONS[definition_index];
            let amount = probe.buffered_by_definition[definition_index];
            if amount < 1.0 {
                continue;
            }
            entity
                .get_mut("inputs")
                .and_then(Value::as_object_mut)
                .ok_or_else(|| anyhow!("native galactic exporter inputs are missing"))?
                .insert(definition.item_id.to_owned(), Value::from(0));
            record_delivery(&mut endgame, definition, amount, true)?;
            delivered += amount;
        }
        set_number(
            entity,
            "utilization",
            if delivered > 0.0 {
                probe.power_factor
            } else {
                0.0
            },
        )?;
        set_number(entity, "productionRate", delivered * 60.0)?;
    }

    if completed_tech(base, "universe_matrix")
        && endgame.get("exportInputMode").and_then(Value::as_str) == Some("legacy-network")
        && endgame.get("autoDispatch").and_then(Value::as_bool) == Some(true)
        && seconds > EPSILON
    {
        let mut enabled = DEFINITIONS
            .iter()
            .copied()
            .filter(|definition| {
                endgame
                    .get("exportProjects")
                    .and_then(Value::as_object)
                    .and_then(|projects| projects.get(definition.id))
                    .and_then(Value::as_object)
                    .and_then(|project| project.get("enabled"))
                    .and_then(Value::as_bool)
                    == Some(true)
            })
            .collect::<Vec<_>>();
        enabled.sort_by(|left, right| {
            let priority = |definition: Definition| {
                endgame
                    .get("exportProjects")
                    .and_then(Value::as_object)
                    .and_then(|projects| projects.get(definition.id))
                    .and_then(Value::as_object)
                    .map(|project| finite_number(project.get("priority")))
                    .unwrap_or(0.0)
            };
            priority(*right)
                .partial_cmp(&priority(*left))
                .unwrap_or(Ordering::Equal)
                .then_with(|| left.id.cmp(right.id))
        });
        let logistics_level = endgame
            .get("infiniteResearch")
            .and_then(Value::as_object)
            .and_then(|research| research.get("galactic_logistics"))
            .and_then(Value::as_object)
            .map(|progress| finite_number(progress.get("level")))
            .unwrap_or(0.0);
        let throttle = finite_number(endgame.get("dispatchThrottle"));
        for definition in enabled {
            let rate = definition.base_rate_per_minute * throttle * (1.0 + logistics_level * 0.1);
            let previous =
                finite_number(project(&mut endgame, definition.id)?.get("dispatchProgress"));
            let progress = (previous.max(0.0) + rate * seconds / 60.0).min(rate * 2.0);
            set_number(
                project(&mut endgame, definition.id)?,
                "dispatchProgress",
                progress,
            )?;
            let requested = (progress + EPSILON).floor();
            if requested < 1.0 {
                continue;
            }
            let shipped = dispatch(state, base, entities, &mut endgame, definition, requested)?;
            set_number(
                project(&mut endgame, definition.id)?,
                "dispatchProgress",
                if shipped >= requested {
                    progress - requested
                } else {
                    0.0
                },
            )?;
        }
    }
    base.insert("endgame".to_owned(), Value::Object(endgame));
    Ok(())
}

pub(crate) fn run(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entities: &mut [Value],
    effective_power: &HashMap<usize, f64>,
    allocated_power: &HashMap<usize, f64>,
    seconds: f64,
) -> anyhow::Result<()> {
    run_with_runtime(
        deterministic_runtime(),
        state,
        base,
        entities,
        effective_power,
        allocated_power,
        seconds,
    )
}

pub(crate) fn admission_reason(state: &CoreState) -> anyhow::Result<Option<&'static str>> {
    let base = state.base_value();
    let endgame = base
        .get("endgame")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native galactic endgame state is missing"))?;
    if !matches!(
        endgame.get("exportInputMode").and_then(Value::as_str),
        Some("building" | "legacy-network")
    ) {
        return Ok(Some("galactic-export-mode-invalid"));
    }
    let projects = endgame
        .get("exportProjects")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native galactic export projects are missing"))?;
    for definition in DEFINITIONS {
        let Some(project) = projects.get(definition.id).and_then(Value::as_object) else {
            return Ok(Some("galactic-export-project-invalid"));
        };
        if project.get("enabled").and_then(Value::as_bool).is_none()
            || !matches!(
                project.get("priority").and_then(Value::as_f64),
                Some(1.0 | 2.0 | 3.0)
            )
            || ["level", "delivered", "totalDelivered", "dispatchProgress"]
                .iter()
                .any(|key| {
                    project
                        .get(*key)
                        .and_then(Value::as_f64)
                        .is_none_or(|value| !value.is_finite() || value < 0.0)
                })
        {
            return Ok(Some("galactic-export-project-invalid"));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deterministic_runtime::PARALLEL_MIN_ITEMS;

    fn certified_base() -> Map<String, Value> {
        serde_json::json!({
            "research": { "completedTechIds": ["universe_matrix"] },
            "tray": {
                "universe_matrix": 0,
                "solar_sail": 0,
                "small_carrier_rocket": 0,
                "antimatter_fuel_rod": 0
            },
            "planetTrays": {},
            "quantumLogisticsNetwork": { "inventory": {} },
            "endgame": {
                "activeInfiniteResearchId": null,
                "autoResearch": true,
                "autoDispatch": false,
                "dispatchThrottle": 1,
                "exportProjects": {
                    "universe_archive": {
                        "id": "universe_archive",
                        "enabled": true,
                        "priority": 1,
                        "level": 0,
                        "delivered": 0,
                        "totalDelivered": 0,
                        "dispatchProgress": 0
                    },
                    "solar_sail_array": {
                        "id": "solar_sail_array",
                        "enabled": true,
                        "priority": 1,
                        "level": 0,
                        "delivered": 0,
                        "totalDelivered": 0,
                        "dispatchProgress": 0
                    },
                    "carrier_rocket_fleet": {
                        "id": "carrier_rocket_fleet",
                        "enabled": true,
                        "priority": 1,
                        "level": 0,
                        "delivered": 0,
                        "totalDelivered": 0,
                        "dispatchProgress": 0
                    },
                    "antimatter_exchange": {
                        "id": "antimatter_exchange",
                        "enabled": true,
                        "priority": 1,
                        "level": 0,
                        "delivered": 0,
                        "totalDelivered": 0,
                        "dispatchProgress": 0
                    }
                },
                "galacticCredits": 0,
                "galacticScore": 0,
                "totalExported": 0,
                "exportedLastMinute": 0,
                "exportWindowAmount": 0,
                "exportWindowStartedAt": 0,
                "infiniteResearch": {
                    "galactic_logistics": { "level": 0, "progress": "0" }
                },
                "exportInputMode": "building",
                "constructionActivity": {
                    "activityId": "certified-activity",
                    "participantId": "certified-participant",
                    "configRevision": "certified-config",
                    "startsAtMs": 1000,
                    "endsAtMs": 10000,
                    "serverTimeAnchorMs": 1500,
                    "activityClockMs": 1500,
                    "personalTargets": {
                        "universe_matrix": 1000000,
                        "solar_sail": 1000000,
                        "small_carrier_rocket": 1000000,
                        "antimatter_fuel_rod": 1000000
                    },
                    "globalTargets": {
                        "universe_matrix": 1000000000,
                        "solar_sail": 1000000000,
                        "small_carrier_rocket": 1000000000,
                        "antimatter_fuel_rod": 1000000000
                    },
                    "personalDelivered": {
                        "universe_matrix": 0,
                        "solar_sail": 0,
                        "small_carrier_rocket": 0,
                        "antimatter_fuel_rod": 0
                    },
                    "pendingBatches": {},
                    "nextBatchSequence": 0
                }
            }
        })
        .as_object()
        .unwrap()
        .clone()
    }

    fn apply_budget(
        base: &mut Map<String, Value>,
        budgets: BTreeMap<String, i128>,
    ) -> CertifiedPureIdleExportReceipt {
        let endpoint = capture_certified_pure_idle_export_endpoint(base).unwrap();
        let activity_clock_ms = endpoint.activity.activity_clock_ms;
        apply_certified_pure_idle_export_budget(
            base,
            &endpoint,
            &budgets,
            activity_clock_ms,
            activity_clock_ms,
        )
        .unwrap()
    }

    fn project_mut<'a>(
        base: &'a mut Map<String, Value>,
        project_id: &str,
    ) -> &'a mut Map<String, Value> {
        base.get_mut("endgame")
            .and_then(Value::as_object_mut)
            .and_then(|endgame| endgame.get_mut("exportProjects"))
            .and_then(Value::as_object_mut)
            .and_then(|projects| projects.get_mut(project_id))
            .and_then(Value::as_object_mut)
            .unwrap()
    }

    #[test]
    fn certified_export_spends_no_more_than_the_new_production_budget() {
        let mut base = certified_base();
        base["endgame"]["exportedLastMinute"] = Value::from(7.25);
        base["endgame"]["exportWindowAmount"] = Value::from(91);
        base["endgame"]["exportWindowStartedAt"] = Value::from(10.5);
        let telemetry_before = (
            base["endgame"]["exportedLastMinute"].clone(),
            base["endgame"]["exportWindowAmount"].clone(),
            base["endgame"]["exportWindowStartedAt"].clone(),
        );
        let receipt = apply_budget(
            &mut base,
            BTreeMap::from([
                ("universe_matrix".to_owned(), 25),
                ("iron_ore".to_owned(), 9_000_000),
            ]),
        );

        assert_eq!(receipt.requested_by_item["universe_matrix"], 25);
        assert_eq!(receipt.consumed_by_item["universe_matrix"], 25);
        assert!(!receipt.clipped);
        assert_eq!(
            base["endgame"]["exportProjects"]["universe_archive"]["totalDelivered"],
            Value::from(25.0)
        );
        assert_eq!(base["endgame"]["totalExported"], Value::from(25.0));
        assert!(!receipt.consumed_by_item.contains_key("iron_ore"));
        assert_eq!(
            (
                base["endgame"]["exportedLastMinute"].clone(),
                base["endgame"]["exportWindowAmount"].clone(),
                base["endgame"]["exportWindowStartedAt"].clone(),
            ),
            telemetry_before,
            "certified tail freezes rolling export telemetry",
        );
    }

    #[test]
    fn certified_export_never_reads_prefilled_tray_entity_or_quantum_inventory() {
        let mut base = certified_base();
        base["tray"]["universe_matrix"] = Value::from(8_000_000);
        base["planetTrays"] = serde_json::json!({
            "home": { "universe_matrix": 7_000_000 }
        });
        base["quantumLogisticsNetwork"]["inventory"] = serde_json::json!({
            "universe_matrix": "6000000"
        });
        base.insert(
            "entities".to_owned(),
            serde_json::json!([{
                "id": "prefilled-exporter",
                "inputs": { "universe_matrix": 5000000 },
                "outputs": { "universe_matrix": 4000000 }
            }]),
        );
        let owned_before = (
            base["tray"].clone(),
            base["planetTrays"].clone(),
            base["quantumLogisticsNetwork"].clone(),
            base["entities"].clone(),
        );

        let receipt = apply_budget(
            &mut base,
            BTreeMap::from([("universe_matrix".to_owned(), 2)]),
        );

        assert_eq!(receipt.consumed_by_item["universe_matrix"], 2);
        assert_eq!(
            (
                base["tray"].clone(),
                base["planetTrays"].clone(),
                base["quantumLogisticsNetwork"].clone(),
                base["entities"].clone(),
            ),
            owned_before,
            "starting owned inventory is outside the certified terminal API",
        );
    }

    #[test]
    fn certified_export_priority_and_definition_order_share_counter_headroom_stably() {
        let mut base = certified_base();
        project_mut(&mut base, "universe_archive").insert("priority".to_owned(), Value::from(3));
        project_mut(&mut base, "solar_sail_array").insert("priority".to_owned(), Value::from(1));
        let endgame = base["endgame"].as_object_mut().unwrap();
        endgame.insert(
            "galacticCredits".to_owned(),
            Value::from((MAX_SAFE_INTEGER - 15) as i64),
        );
        endgame.insert(
            "galacticScore".to_owned(),
            Value::from((MAX_SAFE_INTEGER - 15) as i64),
        );

        let receipt = apply_budget(
            &mut base,
            BTreeMap::from([
                ("solar_sail".to_owned(), 20),
                ("universe_matrix".to_owned(), 20),
            ]),
        );

        assert_eq!(receipt.consumed_by_item["universe_matrix"], 1);
        assert_eq!(receipt.consumed_by_item["solar_sail"], 1);
        assert!(receipt.items["universe_matrix"].counter_limited);
        assert!(receipt.items["solar_sail"].counter_limited);
        let batches = &receipt.endpoint_after.activity.pending_batches;
        assert_eq!(batches["universe_matrix"].sequence, 0);
        assert_eq!(batches["solar_sail"].sequence, 1);
        assert_eq!(receipt.reward_credits, 15);
        assert_eq!(receipt.endpoint_after.galactic_credits, MAX_SAFE_INTEGER);
    }

    #[test]
    fn certified_export_stops_one_unit_before_the_first_level_reward_boundary() {
        let mut base = certified_base();
        let project = project_mut(&mut base, "universe_archive");
        project.insert("delivered".to_owned(), Value::from(995));
        project.insert("totalDelivered".to_owned(), Value::from(995));
        base["endgame"]["totalExported"] = Value::from(995);
        base["endgame"]["exportWindowAmount"] = Value::from(995);

        let receipt = apply_budget(
            &mut base,
            BTreeMap::from([("universe_matrix".to_owned(), 10)]),
        );
        let item = &receipt.items["universe_matrix"];

        assert_eq!(item.consumed, 4);
        assert_eq!(item.unconsumed_budget, 6);
        assert_eq!(item.level_before, 0);
        assert_eq!(item.level_after, 0);
        assert_eq!(item.units_until_level_reward_before, 5);
        assert_eq!(item.units_until_level_reward_after, 1);
        assert!(item.boundary_limited);
        assert!(receipt.boundary_limited);
        assert!(receipt.clipped);
        assert_eq!(receipt.reward_credits, 48);
    }

    #[test]
    fn endpoint_delta_recognizes_an_exact_level_reward_without_double_counting_activity() {
        let mut base = certified_base();
        let project = project_mut(&mut base, "universe_archive");
        project.insert("delivered".to_owned(), Value::from(999));
        project.insert("totalDelivered".to_owned(), Value::from(999));
        base["endgame"]["totalExported"] = Value::from(999);
        base["endgame"]["exportWindowAmount"] = Value::from(999);
        let before = capture_certified_pure_idle_export_endpoint(&base).unwrap();
        let mut endgame = base
            .remove("endgame")
            .and_then(|endgame| endgame.as_object().cloned())
            .unwrap();
        record_delivery(&mut endgame, DEFINITIONS[0], 1.0, true).unwrap();
        base.insert("endgame".to_owned(), Value::Object(endgame));
        let after = capture_certified_pure_idle_export_endpoint(&base).unwrap();

        let delta = delta_certified_pure_idle_export_endpoints(&before, &after).unwrap();
        assert_eq!(delta.physical_consumed_by_item["universe_matrix"], 1);
        assert_eq!(delta.activity_personal_mirror_by_item["universe_matrix"], 1);
        assert_eq!(delta.activity_pending_mirror_by_item["universe_matrix"], 1);
        assert_eq!(delta.total_exported, 1);
        assert_eq!(delta.reward_credits, 12_012);
        assert_eq!(delta.level_boundaries["universe_matrix"].level_after, 1);
        assert!(!delta.pending_activity_batches_are_owned_inventory);
    }

    #[test]
    fn endpoint_delta_treats_export_window_rollover_as_non_material_telemetry() {
        let mut base = certified_base();
        base["endgame"]["exportWindowAmount"] = Value::from(99);
        let before = capture_certified_pure_idle_export_endpoint(&base).unwrap();
        let mut endgame = base
            .remove("endgame")
            .and_then(|endgame| endgame.as_object().cloned())
            .unwrap();
        record_delivery(&mut endgame, DEFINITIONS[1], 3.0, true).unwrap();
        endgame.insert("exportedLastMinute".to_owned(), Value::from(612.5));
        endgame.insert("exportWindowAmount".to_owned(), Value::from(0));
        endgame.insert("exportWindowStartedAt".to_owned(), Value::from(10));
        base.insert("endgame".to_owned(), Value::Object(endgame));
        let after = capture_certified_pure_idle_export_endpoint(&base).unwrap();

        let delta = delta_certified_pure_idle_export_endpoints(&before, &after).unwrap();
        assert_eq!(delta.physical_consumed_by_item["solar_sail"], 3);
        assert_eq!(delta.activity_personal_mirror_by_item["solar_sail"], 3);
        assert_eq!(delta.total_exported, 3);
    }

    #[test]
    fn certified_export_updates_existing_activity_batch_as_a_non_owned_mirror() {
        let mut base = certified_base();
        base["endgame"]["constructionActivity"]["activityClockMs"] = Value::from(2_000);
        base["endgame"]["constructionActivity"]["personalDelivered"]["solar_sail"] = Value::from(7);
        base["endgame"]["constructionActivity"]["pendingBatches"] = serde_json::json!({
            "solar_sail": {
                "id": "certified-activity:certified-participant:solar_sail:0",
                "itemId": "solar_sail",
                "amount": 7,
                "sequence": 0,
                "firstDeliveredAtMs": 1500,
                "lastDeliveredAtMs": 1500
            }
        });
        base["endgame"]["constructionActivity"]["nextBatchSequence"] = Value::from(1);

        let receipt = apply_budget(&mut base, BTreeMap::from([("solar_sail".to_owned(), 3)]));

        assert_eq!(receipt.activity_personal_mirror_by_item["solar_sail"], 3);
        assert_eq!(receipt.activity_pending_mirror_by_item["solar_sail"], 3);
        assert!(!receipt.pending_activity_batches_are_owned_inventory);
        let batch = &receipt.endpoint_after.activity.pending_batches["solar_sail"];
        assert_eq!(batch.amount, 10);
        assert_eq!(batch.first_delivered_at_ms, 1500);
        assert_eq!(batch.last_delivered_at_ms, 2000);
        assert_eq!(receipt.endpoint_after.activity.next_batch_sequence, 1);
    }

    #[test]
    fn certified_export_one_shot_and_segmented_budgets_are_identical() {
        let source = certified_base();
        let mut one_shot = source.clone();
        let mut segmented = source;

        let one_endpoint = capture_certified_pure_idle_export_endpoint(&one_shot).unwrap();
        let one_receipt = apply_certified_pure_idle_export_budget(
            &mut one_shot,
            &one_endpoint,
            &BTreeMap::from([("small_carrier_rocket".to_owned(), 10)]),
            3_000,
            3_000,
        )
        .unwrap();
        let first_endpoint = capture_certified_pure_idle_export_endpoint(&segmented).unwrap();
        let first = apply_certified_pure_idle_export_budget(
            &mut segmented,
            &first_endpoint,
            &BTreeMap::from([("small_carrier_rocket".to_owned(), 4)]),
            2_000,
            2_000,
        )
        .unwrap();
        let second = apply_certified_pure_idle_export_budget(
            &mut segmented,
            &first.endpoint_after,
            &BTreeMap::from([("small_carrier_rocket".to_owned(), 6)]),
            3_000,
            3_000,
        )
        .unwrap();

        assert_eq!(one_shot, segmented);
        assert_eq!(
            one_receipt.reward_credits,
            first.reward_credits + second.reward_credits
        );
        assert_eq!(one_receipt.consumed_by_item["small_carrier_rocket"], 10);
        assert_eq!(
            first.consumed_by_item["small_carrier_rocket"]
                + second.consumed_by_item["small_carrier_rocket"],
            10
        );
        assert_eq!(one_receipt.endpoint_after, second.endpoint_after);
    }

    #[test]
    fn certified_export_boundary_and_budget_errors_are_atomic() {
        let mut outside = certified_base();
        outside["endgame"]["constructionActivity"]["activityClockMs"] = Value::from(10_000);
        let outside_endpoint = capture_certified_pure_idle_export_endpoint(&outside).unwrap();
        let outside_bytes = serde_json::to_vec(&outside).unwrap();
        assert!(
            apply_certified_pure_idle_export_budget(
                &mut outside,
                &outside_endpoint,
                &BTreeMap::from([("universe_matrix".to_owned(), 1)]),
                10_000,
                9_999,
            )
            .is_err()
        );
        assert_eq!(serde_json::to_vec(&outside).unwrap(), outside_bytes);

        let mut invalid_budget = certified_base();
        let endpoint = capture_certified_pure_idle_export_endpoint(&invalid_budget).unwrap();
        let bytes = serde_json::to_vec(&invalid_budget).unwrap();
        assert!(
            apply_certified_pure_idle_export_budget(
                &mut invalid_budget,
                &endpoint,
                &BTreeMap::from([("universe_matrix".to_owned(), -1)]),
                1_500,
                1_500,
            )
            .is_err()
        );
        assert_eq!(serde_json::to_vec(&invalid_budget).unwrap(), bytes);

        let mut stale = certified_base();
        let endpoint = capture_certified_pure_idle_export_endpoint(&stale).unwrap();
        project_mut(&mut stale, "universe_archive").insert("priority".to_owned(), Value::from(3));
        let bytes = serde_json::to_vec(&stale).unwrap();
        assert!(
            apply_certified_pure_idle_export_budget(
                &mut stale,
                &endpoint,
                &BTreeMap::from([("universe_matrix".to_owned(), 1)]),
                1_500,
                1_500,
            )
            .is_err()
        );
        assert_eq!(serde_json::to_vec(&stale).unwrap(), bytes);
    }

    #[test]
    fn certified_export_rejects_legacy_or_auto_dispatch_without_mutation() {
        for (mode, auto_dispatch) in [("legacy-network", false), ("building", true)] {
            let mut base = certified_base();
            base["endgame"]["exportInputMode"] = Value::from(mode);
            base["endgame"]["autoDispatch"] = Value::from(auto_dispatch);
            let endpoint = capture_certified_pure_idle_export_endpoint(&base).unwrap();
            let before = serde_json::to_vec(&base).unwrap();
            assert!(
                apply_certified_pure_idle_export_budget(
                    &mut base,
                    &endpoint,
                    &BTreeMap::from([("solar_sail".to_owned(), 2)]),
                    1_500,
                    1_500,
                )
                .is_err()
            );
            assert_eq!(serde_json::to_vec(&base).unwrap(), before);
        }
    }

    #[test]
    fn certified_export_budget_prepare_is_read_only_across_worker_limits() {
        let mut base = certified_base();
        project_mut(&mut base, "universe_archive").insert("priority".to_owned(), Value::from(3));
        project_mut(&mut base, "antimatter_exchange").insert("priority".to_owned(), Value::from(2));
        let endpoint = capture_certified_pure_idle_export_endpoint(&base).unwrap();
        let budgets = BTreeMap::from([
            ("universe_matrix".to_owned(), 11),
            ("solar_sail".to_owned(), 12),
            ("small_carrier_rocket".to_owned(), 13),
            ("antimatter_fuel_rod".to_owned(), 14),
        ]);
        let before = serde_json::to_vec(&base).unwrap();
        let mut baseline = None;

        for worker_limit in [1, 2, 4, 8] {
            let probes = ordered_certified_export_budget_probes_with_runtime(
                &DeterministicRuntime::for_test(worker_limit),
                &endpoint,
                &budgets,
            )
            .unwrap();
            if let Some(expected) = &baseline {
                assert_eq!(&probes, expected);
            } else {
                baseline = Some(probes);
            }
            assert_eq!(serde_json::to_vec(&base).unwrap(), before);
        }
        let ordered_items = baseline
            .unwrap()
            .into_iter()
            .map(|probe| DEFINITIONS[probe.definition_index].item_id)
            .collect::<Vec<_>>();
        assert_eq!(
            ordered_items,
            vec![
                "universe_matrix",
                "antimatter_fuel_rod",
                "small_carrier_rocket",
                "solar_sail",
            ]
        );
    }

    #[test]
    fn empty_certified_budget_advances_and_then_stabilizes_the_activity_clock() {
        let mut base = certified_base();
        let expected = capture_certified_pure_idle_export_endpoint(&base).unwrap();
        let material_before = (
            expected.total_exported,
            expected.galactic_credits,
            expected.galactic_score,
            expected.projects.clone(),
        );
        let receipt = apply_certified_pure_idle_export_budget(
            &mut base,
            &expected,
            &BTreeMap::new(),
            expected.activity.ends_at_ms,
            expected.activity.activity_clock_ms,
        )
        .unwrap();
        assert!(receipt.consumed_by_item.is_empty());
        assert_eq!(
            receipt.endpoint_after.activity.phase,
            CertifiedPureIdleExportActivityPhase::Ended
        );
        assert_eq!(
            (
                receipt.endpoint_after.total_exported,
                receipt.endpoint_after.galactic_credits,
                receipt.endpoint_after.galactic_score,
                receipt.endpoint_after.projects.clone(),
            ),
            material_before,
        );

        let ended = receipt.endpoint_after;
        let second = apply_certified_pure_idle_export_budget(
            &mut base,
            &ended,
            &BTreeMap::new(),
            ended.activity.ends_at_ms,
            ended.activity.activity_clock_ms,
        )
        .unwrap();
        assert_eq!(second.endpoint_after, ended);
    }

    #[test]
    fn aggregate_capacity_does_not_reuse_global_counter_slots_per_project() {
        let mut base = certified_base();
        base["endgame"]["totalExported"] =
            Value::from(i64::try_from(MAX_SAFE_INTEGER - 100).unwrap());
        let endpoint = capture_certified_pure_idle_export_endpoint(&base).unwrap();
        let rates = BTreeMap::from([
            ("universe_matrix".to_owned(), 1),
            ("solar_sail".to_owned(), 1),
        ]);
        assert_eq!(
            certified_pure_idle_export_capacity_seconds(&endpoint, &rates).unwrap(),
            50,
        );

        base["endgame"]["constructionActivity"]["nextBatchSequence"] =
            Value::from(i64::try_from(MAX_SAFE_INTEGER - 1).unwrap());
        let endpoint = capture_certified_pure_idle_export_endpoint(&base).unwrap();
        assert_eq!(
            certified_pure_idle_export_capacity_seconds(&endpoint, &rates).unwrap(),
            0,
            "two first-time item batches cannot share the final sequence slot",
        );
    }

    fn exporter(index: usize) -> Value {
        serde_json::json!({
            "id": format!("exporter-{index}"),
            "galacticExporterPaused": index.is_multiple_of(7),
            "inputs": {
                "universe_matrix": index as f64,
                "solar_sail": (index % 11) as f64,
                "small_carrier_rocket": (index % 13) as f64,
                "antimatter_fuel_rod": (index % 17) as f64,
            },
        })
    }

    #[test]
    fn exporter_probe_is_read_only_and_captures_the_complete_local_row() {
        let entities = vec![exporter(19)];
        let before = entities.clone();
        let effective_power = HashMap::from([(0, 0.625)]);
        let allocated_power = HashMap::from([(0, 42.0)]);
        let probe = probe_exporter(&entities, &effective_power, &allocated_power, 0).unwrap();

        assert_eq!(entities, before);
        assert_eq!(probe.entity_index, 0);
        assert!(probe.allocated_power);
        assert_eq!(probe.power_factor, 0.625);
        assert!(!probe.paused);
        assert_eq!(probe.buffered_by_definition, [19.0, 8.0, 6.0, 2.0]);
    }

    #[test]
    fn exporter_probe_plan_is_identical_for_one_two_four_and_eight_workers() {
        let entities = (0..PARALLEL_MIN_ITEMS + 113)
            .map(exporter)
            .collect::<Vec<_>>();
        let indices = (0..entities.len()).collect::<Vec<_>>();
        let effective_power = indices
            .iter()
            .copied()
            .filter(|index| index % 3 != 0)
            .map(|index| (index, (index % 101) as f64 / 100.0))
            .collect::<HashMap<_, _>>();
        let allocated_power = indices
            .iter()
            .copied()
            .filter(|index| index % 5 != 0)
            .map(|index| (index, 1.0))
            .collect::<HashMap<_, _>>();
        let mut baseline = None;

        for worker_limit in [1, 2, 4, 8] {
            let runtime = DeterministicRuntime::for_test(worker_limit);
            let probes =
                collect_ordered_exporter_probes_with_runtime(&runtime, &indices, |entity_index| {
                    probe_exporter(&entities, &effective_power, &allocated_power, entity_index)
                })
                .unwrap();
            if let Some(expected) = &baseline {
                assert_eq!(&probes, expected);
            } else {
                baseline = Some(probes);
            }
        }
    }

    #[test]
    fn parallel_exporter_probe_reports_the_lowest_topology_error() {
        let runtime = DeterministicRuntime::for_test(8);
        let indices = (0..PARALLEL_MIN_ITEMS + 257).collect::<Vec<_>>();
        let error =
            collect_ordered_exporter_probes_with_runtime(&runtime, &indices, |entity_index| {
                if matches!(entity_index, 17 | 4_111) {
                    return Err(anyhow!("probe-{entity_index}"));
                }
                Ok(entity_index)
            })
            .unwrap_err();
        assert_eq!(error.to_string(), "probe-17");
    }
}
