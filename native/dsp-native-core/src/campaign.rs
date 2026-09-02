use std::collections::{BTreeMap, HashMap, HashSet};
use std::mem::size_of;
use std::sync::{Mutex, MutexGuard};

use anyhow::{anyhow, bail};
use serde_json::{Map, Value};

use crate::deterministic_runtime::{DeterministicRuntime, runtime as deterministic_runtime};
use crate::state::CoreState;

#[derive(Clone, Copy)]
enum Metric {
    ManualMined(f64),
    Produced(&'static str, f64),
    Building(&'static str, f64),
    Miner(f64),
    Belt { target: f64, minimum_tier: u8 },
    Exploration(&'static str),
    StationTrips(&'static str, f64),
    Dyson(&'static str, f64),
    Power,
    RareResource,
    SprayCoater,
    Blueprint(f64),
    InfiniteResearch(f64),
    Exported(f64),
    GalacticScore(f64),
    EndgameMastery,
}

#[derive(Clone, Copy)]
enum Reward {
    Construction(&'static str, f64),
    Item(&'static str, f64),
}

#[derive(Clone, Copy)]
struct Task {
    id: &'static str,
    chapter: &'static str,
    main: bool,
    prerequisites: &'static [&'static str],
    metric: Metric,
    rewards: &'static [Reward],
}

const TASKS: &[Task] = &[
    Task {
        id: "mine_first_ore",
        chapter: "foundation",
        main: true,
        prerequisites: &[],
        metric: Metric::ManualMined(1.0),
        rewards: &[Reward::Construction("conveyor_belt_mk1", 2.0)],
    },
    Task {
        id: "smelt_iron",
        chapter: "foundation",
        main: true,
        prerequisites: &[],
        metric: Metric::Produced("iron_ingot", 4.0),
        rewards: &[Reward::Construction("assembling_machine_mk1", 1.0)],
    },
    Task {
        id: "deploy_miner",
        chapter: "foundation",
        main: true,
        prerequisites: &[],
        metric: Metric::Miner(1.0),
        rewards: &[Reward::Construction("conveyor_belt_mk1", 4.0)],
    },
    Task {
        id: "lay_first_belt",
        chapter: "blue_matrix",
        main: true,
        prerequisites: &["deploy_miner"],
        metric: Metric::Belt {
            target: 1.0,
            minimum_tier: 0,
        },
        rewards: &[Reward::Construction("storage_mk1", 1.0)],
    },
    Task {
        id: "deploy_matrix_lab",
        chapter: "blue_matrix",
        main: true,
        prerequisites: &["lay_first_belt"],
        metric: Metric::Building("matrix_lab", 1.0),
        rewards: &[Reward::Construction("matrix_lab", 1.0)],
    },
    Task {
        id: "produce_blue_matrix",
        chapter: "blue_matrix",
        main: true,
        prerequisites: &["deploy_matrix_lab"],
        metric: Metric::Produced("electromagnetic_matrix", 1.0),
        rewards: &[Reward::Construction("arc_smelter", 1.0)],
    },
    Task {
        id: "refine_oil",
        chapter: "red_matrix",
        main: true,
        prerequisites: &["produce_blue_matrix"],
        metric: Metric::Produced("refined_oil", 1.0),
        rewards: &[Reward::Construction("oil_refinery", 1.0)],
    },
    Task {
        id: "produce_plastic",
        chapter: "red_matrix",
        main: true,
        prerequisites: &["refine_oil"],
        metric: Metric::Produced("plastic", 1.0),
        rewards: &[Reward::Construction("chemical_plant", 1.0)],
    },
    Task {
        id: "produce_red_matrix",
        chapter: "red_matrix",
        main: true,
        prerequisites: &["produce_plastic"],
        metric: Metric::Produced("energy_matrix", 1.0),
        rewards: &[Reward::Construction("matrix_lab", 1.0)],
    },
    Task {
        id: "deploy_planetary_station",
        chapter: "planetary_logistics",
        main: true,
        prerequisites: &["produce_red_matrix"],
        metric: Metric::Building("planetary_logistics_station", 1.0),
        rewards: &[Reward::Item("logistics_drone", 2.0)],
    },
    Task {
        id: "complete_planetary_trip",
        chapter: "planetary_logistics",
        main: true,
        prerequisites: &["deploy_planetary_station"],
        metric: Metric::StationTrips("planetary_logistics_station", 1.0),
        rewards: &[Reward::Item("logistics_vessel", 1.0)],
    },
    Task {
        id: "produce_structure_matrix",
        chapter: "planetary_logistics",
        main: true,
        prerequisites: &["complete_planetary_trip"],
        metric: Metric::Produced("structure_matrix", 1.0),
        rewards: &[Reward::Construction("interstellar_logistics_station", 1.0)],
    },
    Task {
        id: "unlock_borealis",
        chapter: "interstellar_logistics",
        main: true,
        prerequisites: &["produce_structure_matrix"],
        metric: Metric::Exploration("borealis"),
        rewards: &[Reward::Item("space_warper", 1.0)],
    },
    Task {
        id: "deploy_interstellar_station",
        chapter: "interstellar_logistics",
        main: true,
        prerequisites: &["unlock_borealis"],
        metric: Metric::Building("interstellar_logistics_station", 1.0),
        rewards: &[Reward::Item("logistics_vessel", 2.0)],
    },
    Task {
        id: "complete_interstellar_trip",
        chapter: "interstellar_logistics",
        main: true,
        prerequisites: &["deploy_interstellar_station"],
        metric: Metric::StationTrips("interstellar_logistics_station", 1.0),
        rewards: &[Reward::Construction("orbital_collector", 1.0)],
    },
    Task {
        id: "produce_information_matrix",
        chapter: "matrix_mastery",
        main: true,
        prerequisites: &["complete_interstellar_trip"],
        metric: Metric::Produced("information_matrix", 1.0),
        rewards: &[Reward::Construction("miniature_particle_collider", 1.0)],
    },
    Task {
        id: "produce_gravity_matrix",
        chapter: "matrix_mastery",
        main: true,
        prerequisites: &["produce_information_matrix"],
        metric: Metric::Produced("gravity_matrix", 1.0),
        rewards: &[Reward::Construction("em_rail_ejector", 1.0)],
    },
    Task {
        id: "produce_universe_matrix",
        chapter: "matrix_mastery",
        main: true,
        prerequisites: &["produce_gravity_matrix"],
        metric: Metric::Produced("universe_matrix", 1.0),
        rewards: &[Reward::Construction("vertical_launching_silo", 1.0)],
    },
    Task {
        id: "launch_solar_sail",
        chapter: "dyson_program",
        main: true,
        prerequisites: &["produce_universe_matrix"],
        metric: Metric::Dyson("sails", 1.0),
        rewards: &[Reward::Construction("ray_receiver", 1.0)],
    },
    Task {
        id: "launch_carrier_rocket",
        chapter: "dyson_program",
        main: true,
        prerequisites: &["launch_solar_sail"],
        metric: Metric::Dyson("rockets", 1.0),
        rewards: &[Reward::Construction("vertical_launching_silo", 1.0)],
    },
    Task {
        id: "build_dyson_structure",
        chapter: "dyson_program",
        main: true,
        prerequisites: &["launch_carrier_rocket"],
        metric: Metric::Dyson("structure", 1.0),
        rewards: &[Reward::Construction("artificial_star", 1.0)],
    },
    Task {
        id: "absorb_shell_sail",
        chapter: "dyson_program",
        main: true,
        prerequisites: &["build_dyson_structure"],
        metric: Metric::Dyson("shell", 1.0),
        rewards: &[],
    },
    Task {
        id: "side_storage",
        chapter: "foundation",
        main: false,
        prerequisites: &[],
        metric: Metric::Building("storage_mk1", 1.0),
        rewards: &[Reward::Construction("conveyor_belt_mk1", 2.0)],
    },
    Task {
        id: "side_stable_power",
        chapter: "red_matrix",
        main: false,
        prerequisites: &[],
        metric: Metric::Power,
        rewards: &[Reward::Construction("thermal_power_plant", 1.0)],
    },
    Task {
        id: "side_belt_upgrade",
        chapter: "planetary_logistics",
        main: false,
        prerequisites: &[],
        metric: Metric::Belt {
            target: 1.0,
            minimum_tier: 2,
        },
        rewards: &[Reward::Construction("conveyor_belt_mk2", 4.0)],
    },
    Task {
        id: "side_rare_resource",
        chapter: "interstellar_logistics",
        main: false,
        prerequisites: &[],
        metric: Metric::RareResource,
        rewards: &[Reward::Item("space_warper", 1.0)],
    },
    Task {
        id: "side_spray_coater",
        chapter: "matrix_mastery",
        main: false,
        prerequisites: &[],
        metric: Metric::SprayCoater,
        rewards: &[Reward::Item("proliferator_mk1", 10.0)],
    },
    Task {
        id: "side_blueprint",
        chapter: "dyson_program",
        main: false,
        prerequisites: &[],
        metric: Metric::Blueprint(1.0),
        rewards: &[],
    },
    Task {
        id: "endgame_infinite_research",
        chapter: "galactic_endgame",
        main: true,
        prerequisites: &["absorb_shell_sail"],
        metric: Metric::InfiniteResearch(1.0),
        rewards: &[],
    },
    Task {
        id: "endgame_export",
        chapter: "galactic_endgame",
        main: true,
        prerequisites: &["endgame_infinite_research"],
        metric: Metric::Exported(100.0),
        rewards: &[],
    },
    Task {
        id: "endgame_score",
        chapter: "galactic_endgame",
        main: true,
        prerequisites: &["endgame_export"],
        metric: Metric::GalacticScore(10_000.0),
        rewards: &[],
    },
    Task {
        id: "endgame_mastery",
        chapter: "galactic_endgame",
        main: true,
        prerequisites: &["endgame_score"],
        metric: Metric::EndgameMastery,
        rewards: &[],
    },
];

const CHAPTERS: &[&str] = &[
    "foundation",
    "blue_matrix",
    "red_matrix",
    "planetary_logistics",
    "interstellar_logistics",
    "matrix_mastery",
    "dyson_program",
    "galactic_endgame",
];

const RARE_ITEMS: &[&str] = &[
    "fire_ice",
    "kimberlite_ore",
    "fractal_silicon",
    "organic_crystal",
    "optical_grating_crystal",
    "spiniform_stalagmite_crystal",
    "unipolar_magnet",
];

const CAMPAIGN_WORKSPACE_PROJECTION: &str = "campaign-workspace-v1";
const MAX_CAMPAIGN_WORKSPACE_CHAPTERS: usize = 16;
const MAX_CAMPAIGN_WORKSPACE_TASKS: usize = 64;
const MAX_CAMPAIGN_WORKSPACE_BYTES: usize = 256 * 1024;

/// Cumulative material grants represented by the campaign reward ledger.
///
/// This is intentionally read-only and is used by the native settlement proof
/// to distinguish audited one-time rewards from factory production. Returning
/// the cumulative ledger (rather than a per-step event list) keeps adjacent
/// snapshots replay-safe. Unknown legacy task IDs and catalog entries are
/// ignored exactly like reward application itself.
pub(crate) fn cumulative_material_grants(state: &CoreState) -> BTreeMap<String, u64> {
    let rewarded = state
        .base_value()
        .get("campaign")
        .and_then(Value::as_object)
        .and_then(|campaign| campaign.get("rewardedTaskIds"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect::<HashSet<_>>();
    let mut totals = BTreeMap::<String, u64>::new();
    for task in TASKS.iter().filter(|task| rewarded.contains(task.id)) {
        for reward in task.rewards {
            let (item_id, amount, present) = match reward {
                Reward::Construction(item_id, amount) => (
                    *item_id,
                    *amount,
                    state.catalog.constructions.contains_key(*item_id),
                ),
                Reward::Item(item_id, amount) => (
                    *item_id,
                    *amount,
                    state.catalog.items.contains_key(*item_id),
                ),
            };
            if !present {
                continue;
            }
            let amount = amount.floor().max(0.0) as u64;
            *totals.entry(item_id.to_owned()).or_default() += amount;
        }
    }
    totals
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

fn task_by_id(id: &str) -> Option<&'static Task> {
    TASKS.iter().find(|task| task.id == id)
}

fn normalized_ids(campaign: &Map<String, Value>, key: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    campaign
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|id| task_by_id(id).is_some())
        .filter(|id| seen.insert((*id).to_owned()))
        .map(str::to_owned)
        .collect()
}

pub(crate) fn workspace_task_count() -> usize {
    TASKS.len()
}

pub(crate) fn workspace_completed_task_count(base: &Map<String, Value>) -> usize {
    base.get("campaign")
        .and_then(Value::as_object)
        .map(|campaign| normalized_ids(campaign, "completedTaskIds").len())
        .unwrap_or(0)
}

fn number_in_record(base: &Map<String, Value>, record: &str, key: &str) -> f64 {
    base.get(record)
        .and_then(Value::as_object)
        .and_then(|values| values.get(key))
        .map(|value| finite_number(Some(value)))
        .unwrap_or(0.0)
}

#[derive(Debug, Clone, Default, PartialEq)]
struct CampaignBuildingMetrics {
    count: f64,
    station_trips: f64,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct CampaignFactoryMetrics {
    buildings: HashMap<String, CampaignBuildingMetrics>,
    miner_count: f64,
    belt_counts_by_minimum_tier: HashMap<u8, f64>,
    spray_coater_installed: bool,
}

const CAMPAIGN_METRIC_MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct CampaignMetricContribution {
    building_symbol: u32,
    building_count: u64,
    station_trips: u64,
    miner_count: u64,
    spray_coater_installed: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct CachedCampaignBuildingMetrics {
    count: u64,
    station_trips: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CampaignProjectionLineage {
    slot: String,
    generation: u64,
    root_hash: String,
    checkpoint_revision: u64,
    state_version: u16,
    mode: String,
    registry_fingerprint: String,
    catalog_sha256: String,
    base_primary_checksum: String,
    entity_count: usize,
    belt_count: usize,
}

impl CampaignProjectionLineage {
    fn capture(state: &CoreState) -> Self {
        Self {
            slot: state.identity.slot.clone(),
            generation: state.identity.generation,
            root_hash: state.identity.root_hash.clone(),
            checkpoint_revision: state.identity.revision,
            state_version: state.identity.state_version,
            mode: state.identity.mode.clone(),
            registry_fingerprint: state.identity.registry_fingerprint.clone(),
            catalog_sha256: state.catalog.fingerprint.clone(),
            base_primary_checksum: state.identity.base_primary_checksum.clone(),
            entity_count: state.entities.ids.len(),
            belt_count: state.belts.ids.len(),
        }
    }

    fn estimated_bytes(&self) -> u64 {
        u64::try_from(
            size_of::<Self>()
                .saturating_add(self.slot.capacity())
                .saturating_add(self.root_hash.capacity())
                .saturating_add(self.mode.capacity())
                .saturating_add(self.registry_fingerprint.capacity())
                .saturating_add(self.catalog_sha256.capacity())
                .saturating_add(self.base_primary_checksum.capacity()),
        )
        .unwrap_or(u64::MAX)
    }
}

#[derive(Debug, Clone)]
struct CampaignMetricCache {
    lineage: CampaignProjectionLineage,
    revision: u64,
    contributions: Vec<CampaignMetricContribution>,
    buildings: HashMap<u32, CachedCampaignBuildingMetrics>,
    miner_count: u64,
    belt_counts_by_minimum_tier: HashMap<u8, u64>,
    spray_coater_count: u64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct CampaignProjectionDiagnostics {
    pub mode: &'static str,
    pub entity_rows_visited: usize,
    pub belt_rows_visited: usize,
    pub selected_worker_count: usize,
}

#[derive(Debug, Default)]
struct CampaignProjectionRuntimeState {
    cache: Option<CampaignMetricCache>,
    /// A lineage-scoped negative cache. Fractional/MOD metric rows are valid
    /// under the legacy f64 collector but cannot be patched with the exact
    /// integer ledger. Remember that proof failure so every exact revision
    /// does not perform another doomed O(all entities) rebuild attempt.
    unsupported_lineage: Option<CampaignProjectionLineage>,
    diagnostics: CampaignProjectionDiagnostics,
}

/// Session-only campaign metric cache. It never enters GameState, checkpoint,
/// WAL or canonical hashes. Transactional CoreState clones start empty so an
/// abandoned candidate cannot publish a read-model update into its source.
#[derive(Debug, Default)]
pub(crate) struct CampaignProjectionRuntime(Mutex<CampaignProjectionRuntimeState>);

impl Clone for CampaignProjectionRuntime {
    fn clone(&self) -> Self {
        Self::default()
    }
}

#[derive(Debug)]
struct PreparedCampaignMetricChange {
    index: usize,
    contribution: CampaignMetricContribution,
}

#[derive(Debug)]
enum PreparedCampaignProjectionUpdateInner {
    Reset,
    Unsupported {
        lineage: CampaignProjectionLineage,
        entity_rows_visited: usize,
        selected_worker_count: usize,
    },
    Rebuild {
        cache: CampaignMetricCache,
        entity_rows_visited: usize,
        belt_rows_visited: usize,
        selected_worker_count: usize,
    },
    Incremental {
        expected_revision: u64,
        revision: u64,
        lineage: CampaignProjectionLineage,
        changes: Vec<PreparedCampaignMetricChange>,
        buildings: HashMap<u32, CachedCampaignBuildingMetrics>,
        miner_count: u64,
        belt_counts_by_minimum_tier: HashMap<u8, u64>,
        spray_coater_count: u64,
    },
}

#[derive(Debug)]
pub(crate) struct PreparedCampaignProjectionUpdate(PreparedCampaignProjectionUpdateInner);

impl PreparedCampaignProjectionUpdate {
    pub(crate) fn factory_metrics(&self, state: &CoreState) -> Option<CampaignFactoryMetrics> {
        match &self.0 {
            PreparedCampaignProjectionUpdateInner::Reset
            | PreparedCampaignProjectionUpdateInner::Unsupported { .. } => None,
            PreparedCampaignProjectionUpdateInner::Rebuild { cache, .. } => cache.metrics(state),
            PreparedCampaignProjectionUpdateInner::Incremental {
                buildings,
                miner_count,
                belt_counts_by_minimum_tier,
                spray_coater_count,
                ..
            } => campaign_metrics_from_totals(
                state,
                buildings,
                *miner_count,
                belt_counts_by_minimum_tier,
                *spray_coater_count,
            ),
        }
    }
}

struct CampaignEntityMetricProbe {
    building_id: Option<String>,
    building_count: f64,
    station_trips: f64,
    miner_count: f64,
    spray_coater_installed: bool,
}

fn campaign_entity_metric_probe(entity: &Map<String, Value>) -> CampaignEntityMetricProbe {
    let miner_count = finite_number(entity.get("minerCount"));
    let building_id = string_at(entity, "buildingId").map(str::to_owned);
    let building_count = building_id.as_ref().map_or(0.0, |_| {
        let machine_count = finite_number(entity.get("machineCount"));
        if machine_count != 0.0 {
            machine_count
        } else {
            miner_count
        }
        .max(1.0)
    });
    CampaignEntityMetricProbe {
        building_id,
        building_count,
        station_trips: finite_number(entity.get("stationTrips")),
        miner_count,
        spray_coater_installed: entity
            .get("sprayCoaterInstalled")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    }
}

impl CampaignFactoryMetrics {
    fn apply_entity_probe(&mut self, probe: CampaignEntityMetricProbe) {
        self.miner_count += probe.miner_count;
        self.spray_coater_installed |= probe.spray_coater_installed;
        let Some(building_id) = probe.building_id else {
            return;
        };
        let building = self.buildings.entry(building_id).or_default();
        building.count += probe.building_count;
        building.station_trips += probe.station_trips;
    }

    fn observe_entity_parts(
        &mut self,
        building_id: Option<&str>,
        machine_count: f64,
        miner_count: f64,
        station_trips: f64,
        spray_coater_installed: bool,
    ) {
        self.miner_count += miner_count;
        self.spray_coater_installed |= spray_coater_installed;
        let Some(building_id) = building_id else {
            return;
        };
        let building_count = if machine_count != 0.0 {
            machine_count
        } else {
            miner_count
        }
        .max(1.0);
        if let Some(building) = self.buildings.get_mut(building_id) {
            building.count += building_count;
            building.station_trips += station_trips;
        } else {
            self.buildings.insert(
                building_id.to_owned(),
                CampaignBuildingMetrics {
                    count: building_count,
                    station_trips,
                },
            );
        }
    }

    pub(crate) fn observe_indexed_entity(
        &mut self,
        state: &CoreState,
        index: usize,
        entity: &Map<String, Value>,
    ) {
        self.observe_entity_parts(
            state
                .entities
                .buildings
                .get(index)
                .and_then(|symbol| state.symbols.resolve(*symbol)),
            state
                .entities
                .machine_counts
                .get(index)
                .copied()
                .unwrap_or(0.0),
            state
                .entities
                .miner_counts
                .get(index)
                .copied()
                .unwrap_or(0.0),
            finite_number(entity.get("stationTrips")),
            entity
                .get("sprayCoaterInstalled")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        );
    }

    pub(crate) fn observe_belts(&mut self, belt_tiers: &[u8]) {
        let minimum_belt_tiers = TASKS
            .iter()
            .filter_map(|task| match task.metric {
                Metric::Belt { minimum_tier, .. } => Some(minimum_tier),
                _ => None,
            })
            .collect::<HashSet<_>>();
        for &tier in belt_tiers {
            for &minimum_tier in &minimum_belt_tiers {
                if minimum_tier == 0 || tier >= minimum_tier {
                    *self
                        .belt_counts_by_minimum_tier
                        .entry(minimum_tier)
                        .or_default() += 1.0;
                }
            }
        }
    }

    pub(crate) fn collect(state: &CoreState, entities: &[Value]) -> Self {
        Self::collect_with_runtime(deterministic_runtime(), &state.belts.tiers, entities)
    }

    fn collect_with_runtime(
        runtime: &DeterministicRuntime,
        belt_tiers: &[u8],
        entities: &[Value],
    ) -> Self {
        let mut metrics = Self::default();
        // Entity inspection is read-only and independent. Parallel workers
        // produce an index-aligned probe vector; the serial replay below keeps
        // legacy entity-order floating-point accumulation and map mutation.
        let inspect = |entity: &Value| {
            let entity = entity.as_object()?;
            Some(campaign_entity_metric_probe(entity))
        };
        if runtime.worker_count_for_items(entities.len()) == 1 {
            for probe in entities.iter().filter_map(inspect) {
                metrics.apply_entity_probe(probe);
            }
        } else {
            for probe in runtime
                .indexed_map(entities, |_, entity| inspect(entity))
                .into_iter()
                .flatten()
            {
                metrics.apply_entity_probe(probe);
            }
        }
        metrics.observe_belts(belt_tiers);
        metrics
    }
}

fn campaign_safe_integer(value: f64) -> Option<u64> {
    (value.is_finite()
        && value >= 0.0
        && value.fract() == 0.0
        && value <= CAMPAIGN_METRIC_MAX_SAFE_INTEGER as f64)
        .then_some(value as u64)
}

fn campaign_cached_contribution(
    state: &CoreState,
    index: usize,
    entity: &Value,
) -> Option<CampaignMetricContribution> {
    let Some(entity) = entity.as_object() else {
        return Some(CampaignMetricContribution {
            building_symbol: u32::MAX,
            ..CampaignMetricContribution::default()
        });
    };
    let miner_count = campaign_safe_integer(finite_number(entity.get("minerCount")))?;
    let machine_count = campaign_safe_integer(finite_number(entity.get("machineCount")))?;
    let station_trips = campaign_safe_integer(finite_number(entity.get("stationTrips")))?;
    let building_symbol = match string_at(entity, "buildingId") {
        Some(building_id) => state.symbols.lookup(building_id)?,
        None => u32::MAX,
    };
    let building_count = if building_symbol == u32::MAX {
        0
    } else {
        (if machine_count != 0 {
            machine_count
        } else {
            miner_count
        })
        .max(1)
    };
    debug_assert!(index < state.entities.ids.len());
    Some(CampaignMetricContribution {
        building_symbol,
        building_count,
        station_trips: if building_symbol == u32::MAX {
            0
        } else {
            station_trips
        },
        miner_count,
        spray_coater_installed: entity
            .get("sprayCoaterInstalled")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

fn campaign_checked_add(value: &mut u64, amount: u64) -> Option<()> {
    *value = value.checked_add(amount)?;
    (*value <= CAMPAIGN_METRIC_MAX_SAFE_INTEGER).then_some(())
}

fn campaign_checked_sub(value: &mut u64, amount: u64) -> Option<()> {
    *value = value.checked_sub(amount)?;
    Some(())
}

fn apply_cached_contribution(
    buildings: &mut HashMap<u32, CachedCampaignBuildingMetrics>,
    miner_count: &mut u64,
    spray_coater_count: &mut u64,
    contribution: CampaignMetricContribution,
    add: bool,
) -> Option<()> {
    let update = |value: &mut u64, amount: u64| {
        if add {
            campaign_checked_add(value, amount)
        } else {
            campaign_checked_sub(value, amount)
        }
    };
    update(miner_count, contribution.miner_count)?;
    update(
        spray_coater_count,
        u64::from(contribution.spray_coater_installed),
    )?;
    if contribution.building_symbol != u32::MAX {
        let building = buildings.entry(contribution.building_symbol).or_default();
        update(&mut building.count, contribution.building_count)?;
        update(&mut building.station_trips, contribution.station_trips)?;
        if !add && building.count == 0 && building.station_trips == 0 {
            buildings.remove(&contribution.building_symbol);
        }
    }
    Some(())
}

fn campaign_metrics_from_totals(
    state: &CoreState,
    cached_buildings: &HashMap<u32, CachedCampaignBuildingMetrics>,
    miner_count: u64,
    belt_counts_by_minimum_tier: &HashMap<u8, u64>,
    spray_coater_count: u64,
) -> Option<CampaignFactoryMetrics> {
    let mut buildings = HashMap::with_capacity(cached_buildings.len());
    for (&symbol, cached) in cached_buildings {
        let building_id = state.symbols.resolve(symbol)?;
        buildings.insert(
            building_id.to_owned(),
            CampaignBuildingMetrics {
                count: cached.count as f64,
                station_trips: cached.station_trips as f64,
            },
        );
    }
    Some(CampaignFactoryMetrics {
        buildings,
        miner_count: miner_count as f64,
        belt_counts_by_minimum_tier: belt_counts_by_minimum_tier
            .iter()
            .map(|(&tier, &count)| (tier, count as f64))
            .collect(),
        spray_coater_installed: spray_coater_count != 0,
    })
}

impl CampaignMetricCache {
    fn build(
        state: &CoreState,
        entities: &[Value],
        runtime: &DeterministicRuntime,
    ) -> Option<Self> {
        if entities.len() != state.entities.ids.len() {
            return None;
        }
        let contributions = if runtime.worker_count_for_items(entities.len()) == 1 {
            entities
                .iter()
                .enumerate()
                .map(|(index, entity)| campaign_cached_contribution(state, index, entity))
                .collect::<Option<Vec<_>>>()?
        } else {
            runtime
                .indexed_map(entities, |index, entity| {
                    campaign_cached_contribution(state, index, entity)
                })
                .into_iter()
                .collect::<Option<Vec<_>>>()?
        };
        let mut buildings = HashMap::new();
        let mut miner_count = 0;
        let mut spray_coater_count = 0;
        for contribution in contributions.iter().copied() {
            apply_cached_contribution(
                &mut buildings,
                &mut miner_count,
                &mut spray_coater_count,
                contribution,
                true,
            )?;
        }
        let minimum_belt_tiers = TASKS
            .iter()
            .filter_map(|task| match task.metric {
                Metric::Belt { minimum_tier, .. } => Some(minimum_tier),
                _ => None,
            })
            .collect::<HashSet<_>>();
        let mut belt_counts_by_minimum_tier = HashMap::<u8, u64>::new();
        for &tier in &state.belts.tiers {
            for &minimum_tier in &minimum_belt_tiers {
                if minimum_tier == 0 || tier >= minimum_tier {
                    let count = belt_counts_by_minimum_tier.entry(minimum_tier).or_default();
                    campaign_checked_add(count, 1)?;
                }
            }
        }
        Some(Self {
            lineage: CampaignProjectionLineage::capture(state),
            revision: state.revision,
            contributions,
            buildings,
            miner_count,
            belt_counts_by_minimum_tier,
            spray_coater_count,
        })
    }

    fn metrics(&self, state: &CoreState) -> Option<CampaignFactoryMetrics> {
        campaign_metrics_from_totals(
            state,
            &self.buildings,
            self.miner_count,
            &self.belt_counts_by_minimum_tier,
            self.spray_coater_count,
        )
    }

    fn estimated_bytes(&self) -> u64 {
        u64::try_from(
            size_of::<Self>()
                .saturating_add(
                    self.contributions.capacity() * size_of::<CampaignMetricContribution>(),
                )
                .saturating_add(
                    self.buildings.capacity()
                        * (size_of::<u32>() + size_of::<CachedCampaignBuildingMetrics>()),
                )
                .saturating_add(
                    self.belt_counts_by_minimum_tier.capacity()
                        * (size_of::<u8>() + size_of::<u64>()),
                )
                .saturating_add(
                    usize::try_from(self.lineage.estimated_bytes())
                        .unwrap_or(usize::MAX)
                        .saturating_sub(size_of::<CampaignProjectionLineage>()),
                ),
        )
        .unwrap_or(u64::MAX)
    }
}

impl CampaignProjectionRuntime {
    fn lock(&self) -> MutexGuard<'_, CampaignProjectionRuntimeState> {
        self.0.lock().unwrap_or_else(|error| error.into_inner())
    }

    pub(crate) fn seed_from_records(
        &self,
        state: &CoreState,
        entities: &[Value],
        runtime: &DeterministicRuntime,
    ) {
        let selected_worker_count = runtime.worker_count_for_items(entities.len());
        let lineage = CampaignProjectionLineage::capture(state);
        let cache = CampaignMetricCache::build(state, entities, runtime);
        let mut runtime_state = self.lock();
        runtime_state.unsupported_lineage = cache.is_none().then_some(lineage);
        runtime_state.cache = cache;
        runtime_state.diagnostics = CampaignProjectionDiagnostics {
            mode: if runtime_state.cache.is_some() {
                "opened-seed"
            } else {
                "opened-unsupported"
            },
            entity_rows_visited: entities.len(),
            belt_rows_visited: state.belts.ids.len(),
            selected_worker_count,
        };
    }

    fn snapshot(
        &self,
        state: &CoreState,
        runtime: &DeterministicRuntime,
    ) -> anyhow::Result<CampaignFactoryMetrics> {
        let lineage = CampaignProjectionLineage::capture(state);
        {
            let mut runtime_state = self.lock();
            if let Some(metrics) = runtime_state
                .cache
                .as_ref()
                .filter(|cache| {
                    cache.revision == state.revision
                        && cache.lineage == lineage
                        && cache.contributions.len() == state.entities.ids.len()
                })
                .and_then(|cache| cache.metrics(state))
            {
                runtime_state.diagnostics = CampaignProjectionDiagnostics {
                    mode: "same-revision-cache",
                    entity_rows_visited: 0,
                    belt_rows_visited: 0,
                    selected_worker_count: 0,
                };
                return Ok(metrics);
            }
        }
        let entities = state.parse_entities_parallel()?;
        let selected_worker_count = runtime.worker_count_for_items(entities.len());
        if let Some(cache) = CampaignMetricCache::build(state, &entities, runtime) {
            let metrics = cache
                .metrics(state)
                .ok_or_else(|| anyhow!("native campaign cache symbol is stale"))?;
            let mut runtime_state = self.lock();
            runtime_state.cache = Some(cache);
            runtime_state.unsupported_lineage = None;
            runtime_state.diagnostics = CampaignProjectionDiagnostics {
                mode: "flat-full-cached",
                entity_rows_visited: entities.len(),
                belt_rows_visited: state.belts.ids.len(),
                selected_worker_count,
            };
            return Ok(metrics);
        }
        let metrics =
            CampaignFactoryMetrics::collect_with_runtime(runtime, &state.belts.tiers, &entities);
        let mut runtime_state = self.lock();
        runtime_state.cache = None;
        runtime_state.unsupported_lineage = Some(lineage);
        runtime_state.diagnostics = CampaignProjectionDiagnostics {
            mode: "flat-full-unsupported",
            entity_rows_visited: entities.len(),
            belt_rows_visited: state.belts.ids.len(),
            selected_worker_count,
        };
        Ok(metrics)
    }

    pub(crate) fn prepare_simulation_update(
        &self,
        state: &CoreState,
        next_entities: &[Value],
        writer_indices: Option<&[usize]>,
        next_revision: u64,
    ) -> PreparedCampaignProjectionUpdate {
        let Some(changed_indices) = writer_indices else {
            return PreparedCampaignProjectionUpdate(PreparedCampaignProjectionUpdateInner::Reset);
        };
        if next_entities.len() != state.entities.ids.len() {
            return PreparedCampaignProjectionUpdate(PreparedCampaignProjectionUpdateInner::Reset);
        }
        let lineage = CampaignProjectionLineage::capture(state);
        let runtime_state = self.lock();
        let cache = runtime_state.cache.as_ref().filter(|cache| {
            cache.revision == state.revision
                && cache.lineage == lineage
                && cache.contributions.len() == state.entities.ids.len()
        });
        if cache.is_none() {
            if runtime_state.unsupported_lineage.as_ref() == Some(&lineage) {
                return PreparedCampaignProjectionUpdate(
                    PreparedCampaignProjectionUpdateInner::Unsupported {
                        lineage,
                        entity_rows_visited: 0,
                        selected_worker_count: 0,
                    },
                );
            }
            if !factory_metrics_needed(state.base_value()) {
                return PreparedCampaignProjectionUpdate(
                    PreparedCampaignProjectionUpdateInner::Reset,
                );
            }
            drop(runtime_state);
            let runtime = deterministic_runtime();
            let selected_worker_count = runtime.worker_count_for_items(next_entities.len());
            let Some(mut cache) = CampaignMetricCache::build(state, next_entities, runtime) else {
                return PreparedCampaignProjectionUpdate(
                    PreparedCampaignProjectionUpdateInner::Unsupported {
                        lineage,
                        entity_rows_visited: next_entities.len(),
                        selected_worker_count,
                    },
                );
            };
            cache.revision = next_revision;
            return PreparedCampaignProjectionUpdate(
                PreparedCampaignProjectionUpdateInner::Rebuild {
                    cache,
                    entity_rows_visited: next_entities.len(),
                    belt_rows_visited: state.belts.ids.len(),
                    selected_worker_count,
                },
            );
        };
        let cache = cache.expect("campaign cache was checked above");
        let mut buildings = cache.buildings.clone();
        let mut miner_count = cache.miner_count;
        let mut spray_coater_count = cache.spray_coater_count;
        let mut changes = Vec::with_capacity(changed_indices.len());
        let mut previous = None;
        for &index in changed_indices {
            if index >= next_entities.len() || previous.is_some_and(|value| value >= index) {
                return PreparedCampaignProjectionUpdate(
                    PreparedCampaignProjectionUpdateInner::Reset,
                );
            }
            previous = Some(index);
            let Some(contribution) =
                campaign_cached_contribution(state, index, &next_entities[index])
            else {
                return PreparedCampaignProjectionUpdate(
                    PreparedCampaignProjectionUpdateInner::Unsupported {
                        lineage,
                        entity_rows_visited: changes.len() + 1,
                        selected_worker_count: 0,
                    },
                );
            };
            if apply_cached_contribution(
                &mut buildings,
                &mut miner_count,
                &mut spray_coater_count,
                cache.contributions[index],
                false,
            )
            .is_none()
                || apply_cached_contribution(
                    &mut buildings,
                    &mut miner_count,
                    &mut spray_coater_count,
                    contribution,
                    true,
                )
                .is_none()
            {
                return PreparedCampaignProjectionUpdate(
                    PreparedCampaignProjectionUpdateInner::Unsupported {
                        lineage,
                        entity_rows_visited: changes.len() + 1,
                        selected_worker_count: 0,
                    },
                );
            }
            changes.push(PreparedCampaignMetricChange {
                index,
                contribution,
            });
        }
        PreparedCampaignProjectionUpdate(PreparedCampaignProjectionUpdateInner::Incremental {
            expected_revision: state.revision,
            revision: next_revision,
            lineage,
            changes,
            buildings,
            miner_count,
            belt_counts_by_minimum_tier: cache.belt_counts_by_minimum_tier.clone(),
            spray_coater_count,
        })
    }

    pub(crate) fn install_simulation_update(&self, update: PreparedCampaignProjectionUpdate) {
        let mut runtime_state = self.lock();
        match update.0 {
            PreparedCampaignProjectionUpdateInner::Reset => {
                runtime_state.cache = None;
                runtime_state.unsupported_lineage = None;
                runtime_state.diagnostics = CampaignProjectionDiagnostics {
                    mode: "invalidated",
                    ..CampaignProjectionDiagnostics::default()
                };
            }
            PreparedCampaignProjectionUpdateInner::Unsupported {
                lineage,
                entity_rows_visited,
                selected_worker_count,
            } => {
                runtime_state.cache = None;
                runtime_state.unsupported_lineage = Some(lineage);
                runtime_state.diagnostics = CampaignProjectionDiagnostics {
                    mode: if entity_rows_visited == 0 {
                        "unsupported-fast-path"
                    } else {
                        "revision-unsupported"
                    },
                    entity_rows_visited,
                    belt_rows_visited: 0,
                    selected_worker_count,
                };
            }
            PreparedCampaignProjectionUpdateInner::Rebuild {
                cache,
                entity_rows_visited,
                belt_rows_visited,
                selected_worker_count,
            } => {
                runtime_state.cache = Some(cache);
                runtime_state.unsupported_lineage = None;
                runtime_state.diagnostics = CampaignProjectionDiagnostics {
                    mode: "revision-rebuild",
                    entity_rows_visited,
                    belt_rows_visited,
                    selected_worker_count,
                };
            }
            PreparedCampaignProjectionUpdateInner::Incremental {
                expected_revision,
                revision,
                lineage,
                changes,
                buildings,
                miner_count,
                belt_counts_by_minimum_tier,
                spray_coater_count,
            } => {
                let Some(cache) = runtime_state.cache.as_mut().filter(|cache| {
                    cache.revision == expected_revision && cache.lineage == lineage
                }) else {
                    runtime_state.cache = None;
                    runtime_state.unsupported_lineage = None;
                    runtime_state.diagnostics = CampaignProjectionDiagnostics {
                        mode: "invalidated",
                        ..CampaignProjectionDiagnostics::default()
                    };
                    return;
                };
                for change in &changes {
                    cache.contributions[change.index] = change.contribution;
                }
                cache.revision = revision;
                cache.buildings = buildings;
                cache.miner_count = miner_count;
                cache.belt_counts_by_minimum_tier = belt_counts_by_minimum_tier;
                cache.spray_coater_count = spray_coater_count;
                runtime_state.unsupported_lineage = None;
                runtime_state.diagnostics = CampaignProjectionDiagnostics {
                    mode: "incremental-update",
                    entity_rows_visited: changes.len(),
                    belt_rows_visited: 0,
                    selected_worker_count: 0,
                };
            }
        }
    }

    pub(crate) fn estimated_bytes(&self) -> u64 {
        let state = self.lock();
        state
            .cache
            .as_ref()
            .map(CampaignMetricCache::estimated_bytes)
            .or_else(|| {
                state
                    .unsupported_lineage
                    .as_ref()
                    .map(CampaignProjectionLineage::estimated_bytes)
            })
            .unwrap_or(0)
    }

    #[cfg(test)]
    pub(crate) fn diagnostics(&self) -> CampaignProjectionDiagnostics {
        self.lock().diagnostics
    }

    pub(crate) fn invalidate(&self) {
        let mut state = self.lock();
        state.cache = None;
        state.unsupported_lineage = None;
        state.diagnostics = CampaignProjectionDiagnostics {
            mode: "invalidated",
            ..CampaignProjectionDiagnostics::default()
        };
    }
}

pub(crate) fn factory_metrics_needed(base: &Map<String, Value>) -> bool {
    let Some(campaign) = base.get("campaign").and_then(Value::as_object) else {
        return false;
    };
    let completed = normalized_ids(campaign, "completedTaskIds")
        .into_iter()
        .collect::<HashSet<_>>();
    !TASKS.iter().all(|task| completed.contains(task.id))
}

fn metric_value(
    base: &Map<String, Value>,
    factory: &CampaignFactoryMetrics,
    metric: Metric,
) -> f64 {
    match metric {
        Metric::ManualMined(_) => finite_number(base.get("manualMined")),
        Metric::Produced(item_id, _) => number_in_record(base, "totalProduced", item_id),
        Metric::Building(building_id, _) => factory
            .buildings
            .get(building_id)
            .map(|building| building.count)
            .unwrap_or(0.0),
        Metric::Miner(_) => factory.miner_count,
        Metric::Belt { minimum_tier, .. } => factory
            .belt_counts_by_minimum_tier
            .get(&minimum_tier)
            .copied()
            .unwrap_or(0.0),
        Metric::Exploration(system_id) => base
            .get("exploration")
            .and_then(Value::as_object)
            .and_then(|exploration| exploration.get("unlockedSystemIds"))
            .and_then(Value::as_array)
            .is_some_and(|ids| ids.iter().any(|id| id.as_str() == Some(system_id)))
            as u8 as f64,
        Metric::StationTrips(building_id, _) => factory
            .buildings
            .get(building_id)
            .map(|building| building.station_trips)
            .unwrap_or(0.0),
        Metric::Dyson(measure, _) => {
            let (record, key) = match measure {
                "sails" => ("dysonSwarm", "totalLaunched"),
                "rockets" => ("dysonSphere", "totalRocketsLaunched"),
                "structure" => ("dysonSphere", "structurePoints"),
                _ => ("dysonSphere", "totalSailsAbsorbed"),
            };
            number_in_record(base, record, key)
        }
        Metric::Power => base
            .get("planetMetrics")
            .and_then(Value::as_object)
            .is_some_and(|metrics| {
                metrics.values().filter_map(Value::as_object).any(|metric| {
                    finite_number(metric.get("demandKw")) > 0.0
                        && finite_number(metric.get("powerFactor")) >= 0.999
                })
            }) as u8 as f64,
        Metric::RareResource => RARE_ITEMS
            .iter()
            .any(|item_id| number_in_record(base, "totalProduced", item_id) >= 1.0)
            as u8 as f64,
        Metric::SprayCoater => factory.spray_coater_installed as u8 as f64,
        Metric::Blueprint(_) => base
            .get("blueprints")
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or(0) as f64,
        Metric::InfiniteResearch(_) => base
            .get("endgame")
            .and_then(Value::as_object)
            .and_then(|endgame| endgame.get("infiniteResearch"))
            .and_then(Value::as_object)
            .map(|research| {
                research
                    .values()
                    .filter_map(Value::as_object)
                    .map(|progress| finite_number(progress.get("level")).floor().max(0.0))
                    .sum()
            })
            .unwrap_or(0.0),
        Metric::Exported(_) => base
            .get("endgame")
            .and_then(Value::as_object)
            .map(|endgame| finite_number(endgame.get("totalExported")).floor().max(0.0))
            .unwrap_or(0.0),
        Metric::GalacticScore(_) => base
            .get("endgame")
            .and_then(Value::as_object)
            .map(|endgame| finite_number(endgame.get("galacticScore")).floor().max(0.0))
            .unwrap_or(0.0),
        Metric::EndgameMastery => base
            .get("endgame")
            .and_then(Value::as_object)
            .and_then(|endgame| endgame.get("exportProjects"))
            .and_then(Value::as_object)
            .is_some_and(|projects| {
                projects.len() >= 4
                    && projects
                        .values()
                        .filter_map(Value::as_object)
                        .all(|project| finite_number(project.get("level")) >= 1.0)
            }) as u8 as f64,
    }
}

fn metric_target(metric: Metric) -> f64 {
    match metric {
        Metric::ManualMined(target)
        | Metric::Produced(_, target)
        | Metric::Building(_, target)
        | Metric::Miner(target)
        | Metric::StationTrips(_, target)
        | Metric::Dyson(_, target)
        | Metric::Blueprint(target)
        | Metric::InfiniteResearch(target)
        | Metric::Exported(target)
        | Metric::GalacticScore(target) => target,
        Metric::Belt { target, .. } => target,
        Metric::Exploration(_)
        | Metric::Power
        | Metric::RareResource
        | Metric::SprayCoater
        | Metric::EndgameMastery => 1.0,
    }
}

fn campaign_locator(task_id: &str) -> Value {
    let pair = match task_id {
        "mine_first_ore" => Some(("item", "iron_ore")),
        "smelt_iron" => Some(("item", "iron_ingot")),
        "deploy_miner" => Some(("entity", "mining_machine")),
        "lay_first_belt" => Some(("entity", "conveyor_belt_mk1")),
        "deploy_matrix_lab" => Some(("entity", "matrix_lab")),
        "produce_blue_matrix" => Some(("item", "electromagnetic_matrix")),
        "refine_oil" => Some(("item", "refined_oil")),
        "produce_plastic" => Some(("item", "plastic")),
        "produce_red_matrix" => Some(("item", "energy_matrix")),
        "deploy_planetary_station" | "complete_planetary_trip" => {
            Some(("entity", "planetary_logistics_station"))
        }
        "produce_structure_matrix" => Some(("item", "structure_matrix")),
        "unlock_borealis" => Some(("workspace", "star-map:borealis")),
        "deploy_interstellar_station" | "complete_interstellar_trip" => {
            Some(("entity", "interstellar_logistics_station"))
        }
        "produce_information_matrix" => Some(("item", "information_matrix")),
        "produce_gravity_matrix" => Some(("item", "gravity_matrix")),
        "produce_universe_matrix" => Some(("item", "universe_matrix")),
        "launch_solar_sail" => Some(("item", "solar_sail")),
        "launch_carrier_rocket" => Some(("item", "small_carrier_rocket")),
        "build_dyson_structure" | "absorb_shell_sail" => Some(("workspace", "dyson:helios")),
        "side_storage" => Some(("entity", "storage_mk1")),
        "side_stable_power" => Some(("entity", "thermal_power_plant")),
        "side_belt_upgrade" => Some(("entity", "conveyor_belt_mk2")),
        "side_rare_resource" => Some(("planet", "frost")),
        "side_spray_coater" => Some(("entity", "spray_coater")),
        "endgame_infinite_research" | "endgame_export" | "endgame_score" | "endgame_mastery" => {
            Some(("workspace", "galaxy"))
        }
        _ => None,
    };
    pair.map_or(
        Value::Null,
        |(kind, target_id)| serde_json::json!({ "kind": kind, "targetId": target_id }),
    )
}

impl CoreState {
    /// Read-only, fixed-catalog campaign view for the native thin renderer.
    ///
    /// The projection deliberately exposes neither the factory graph nor any
    /// inventory container. Renderer navigation receives only a catalog
    /// locator and therefore cannot turn this read into a gameplay mutation.
    pub fn campaign_workspace_projection(
        &self,
        session_id: &str,
        run_id: &str,
        expected_revision: u64,
        expected_registry_fingerprint: &str,
    ) -> anyhow::Result<Value> {
        if expected_revision != self.revision {
            bail!("native campaign workspace revision is stale");
        }
        if expected_registry_fingerprint != self.identity.registry_fingerprint {
            bail!("native campaign workspace registry is stale");
        }
        if session_id.is_empty()
            || session_id.len() > 128
            || run_id.is_empty()
            || run_id.len() > 128
        {
            bail!("native campaign workspace lineage is invalid");
        }
        let campaign = self
            .base_value()
            .get("campaign")
            .and_then(Value::as_object)
            .ok_or_else(|| anyhow!("native campaign workspace state is missing"))?;
        let completed = normalized_ids(campaign, "completedTaskIds")
            .into_iter()
            .collect::<HashSet<_>>();
        let active_task_id = campaign
            .get("activeTaskId")
            .and_then(Value::as_str)
            .and_then(task_by_id)
            .map(|task| task.id);
        let active_chapter_id = campaign
            .get("activeChapterId")
            .and_then(Value::as_str)
            .filter(|id| CHAPTERS.contains(id))
            .or_else(|| active_task_id.and_then(task_by_id).map(|task| task.chapter));

        let factory = self
            .campaign_projection_runtime
            .snapshot(self, deterministic_runtime())?;
        let mut projected_task_count = 0usize;
        let mut completed_task_count = 0usize;
        let mut chapters = Vec::with_capacity(CHAPTERS.len().min(MAX_CAMPAIGN_WORKSPACE_CHAPTERS));
        for chapter_id in CHAPTERS.iter().take(MAX_CAMPAIGN_WORKSPACE_CHAPTERS) {
            let mut tasks = Vec::new();
            let mut chapter_completed = 0usize;
            let chapter_total = TASKS
                .iter()
                .filter(|task| task.chapter == *chapter_id)
                .count();
            for task in TASKS
                .iter()
                .filter(|task| task.chapter == *chapter_id)
                .take(MAX_CAMPAIGN_WORKSPACE_TASKS.saturating_sub(projected_task_count))
            {
                let prerequisites_ready = prerequisites_met(&completed, task);
                let target = metric_target(task.metric).max(1.0);
                let current = metric_value(self.base_value(), &factory, task.metric)
                    .floor()
                    .clamp(0.0, target);
                let complete =
                    completed.contains(task.id) || prerequisites_ready && current >= target;
                let status = if complete {
                    "complete"
                } else if !prerequisites_ready {
                    "locked"
                } else if active_task_id == Some(task.id) {
                    "active"
                } else {
                    "available"
                };
                if complete {
                    chapter_completed += 1;
                    completed_task_count += 1;
                }
                tasks.push(serde_json::json!({
                    "id": task.id,
                    "track": if task.main { "main" } else { "side" },
                    "status": status,
                    "progress": { "current": current, "target": target },
                    "locator": campaign_locator(task.id),
                }));
                projected_task_count += 1;
            }
            chapters.push(serde_json::json!({
                "id": chapter_id,
                "completedCount": chapter_completed,
                "totalCount": chapter_total,
                "complete": chapter_total > 0 && chapter_completed == chapter_total,
                "tasks": tasks,
            }));
        }
        let truncated = CHAPTERS.len() > MAX_CAMPAIGN_WORKSPACE_CHAPTERS
            || TASKS.len() > MAX_CAMPAIGN_WORKSPACE_TASKS;
        let value = serde_json::json!({
            "schemaVersion": 1,
            "projectionType": CAMPAIGN_WORKSPACE_PROJECTION,
            "source": "native-core",
            "stateVersion": 47,
            "sessionId": session_id,
            "runId": run_id,
            "revision": self.revision,
            "registryFingerprint": expected_registry_fingerprint,
            "truncated": truncated,
            "limits": {
                "chapters": MAX_CAMPAIGN_WORKSPACE_CHAPTERS,
                "tasks": MAX_CAMPAIGN_WORKSPACE_TASKS,
                "payloadBytes": MAX_CAMPAIGN_WORKSPACE_BYTES,
            },
            "counts": {
                "chapters": CHAPTERS.len(),
                "tasks": TASKS.len(),
                "completedTasks": completed_task_count,
            },
            "activeChapterId": active_chapter_id,
            "activeTaskId": active_task_id,
            "chapters": chapters,
        });
        if serde_json::to_vec(&value)?.len() > MAX_CAMPAIGN_WORKSPACE_BYTES {
            bail!("native campaign workspace projection exceeds the byte limit");
        }
        Ok(value)
    }
}

fn prerequisites_met(completed: &HashSet<String>, task: &Task) -> bool {
    task.prerequisites.iter().all(|id| completed.contains(*id))
}

fn tray_limit(base: &Map<String, Value>, active_planet: &str) -> f64 {
    base.get("planetTrayItemLimits")
        .and_then(Value::as_object)
        .and_then(|limits| limits.get(active_planet))
        .and_then(Value::as_f64)
        .filter(|limit| limit.is_finite())
        .map(|limit| limit.floor().clamp(1_000.0, 100_000_000.0))
        .unwrap_or(1_000_000.0)
}

fn can_apply_rewards(base: &Map<String, Value>, rewards: &[Reward]) -> bool {
    let active_planet = base
        .get("activePlanetId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let limit = tray_limit(base, active_planet);
    let tray = base.get("tray").and_then(Value::as_object);
    let mut totals = HashMap::<&str, f64>::new();
    for reward in rewards {
        if let Reward::Item(item_id, amount) = reward {
            *totals.entry(item_id).or_default() += amount.floor().max(0.0);
        }
    }
    totals.into_iter().all(|(item_id, amount)| {
        tray.map(|tray| finite_number(tray.get(item_id)).floor())
            .unwrap_or(0.0)
            + amount
            <= limit
    })
}

fn apply_reward(
    state: &CoreState,
    base: &mut Map<String, Value>,
    reward: Reward,
) -> anyhow::Result<()> {
    match reward {
        Reward::Construction(construction_id, amount) => {
            if !state.catalog.constructions.contains_key(construction_id) {
                return Ok(());
            }
            let construction = base
                .get_mut("construction")
                .and_then(Value::as_object_mut)
                .ok_or_else(|| anyhow!("native campaign construction inventory is missing"))?;
            let current = finite_number(construction.get(construction_id));
            construction.insert(
                construction_id.to_owned(),
                Value::from(current + amount.floor().max(0.0)),
            );
        }
        Reward::Item(item_id, amount) => {
            if !state.catalog.items.contains_key(item_id) {
                return Ok(());
            }
            let active_planet = base
                .get("activePlanetId")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow!("native campaign active planet is missing"))?
                .to_owned();
            let tray_snapshot = {
                let tray = base
                    .get_mut("tray")
                    .and_then(Value::as_object_mut)
                    .ok_or_else(|| anyhow!("native campaign tray is missing"))?;
                let current = finite_number(tray.get(item_id));
                tray.insert(
                    item_id.to_owned(),
                    Value::from(current + amount.floor().max(0.0)),
                );
                Value::Object(tray.clone())
            };
            base.get_mut("planetTrays")
                .and_then(Value::as_object_mut)
                .ok_or_else(|| anyhow!("native campaign planet trays are missing"))?
                .insert(active_planet, tray_snapshot);
        }
    }
    Ok(())
}

fn first_pending_task(completed: &HashSet<String>) -> Option<&'static Task> {
    TASKS
        .iter()
        .find(|task| {
            task.main && !completed.contains(task.id) && prerequisites_met(completed, task)
        })
        .or_else(|| {
            TASKS.iter().find(|task| {
                !task.main && !completed.contains(task.id) && prerequisites_met(completed, task)
            })
        })
        .or_else(|| TASKS.iter().find(|task| !completed.contains(task.id)))
}

pub(crate) fn synchronize_with_factory_metrics(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entities: &[Value],
    prepared_factory_metrics: Option<CampaignFactoryMetrics>,
) -> anyhow::Result<()> {
    let campaign = base
        .get("campaign")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native campaign state is missing"))?;
    let mut completed_order = normalized_ids(campaign, "completedTaskIds");
    let mut rewarded_order = normalized_ids(campaign, "rewardedTaskIds");
    let mut completed = completed_order.iter().cloned().collect::<HashSet<_>>();
    let mut rewarded = rewarded_order.iter().cloned().collect::<HashSet<_>>();
    let normalized_active_task = campaign
        .get("activeTaskId")
        .and_then(Value::as_str)
        .and_then(task_by_id)
        .map(|task| task.id.to_owned());
    let normalized_active_chapter = campaign
        .get("activeChapterId")
        .and_then(Value::as_str)
        .filter(|chapter| CHAPTERS.contains(chapter))
        .map(str::to_owned)
        .or_else(|| {
            normalized_active_task
                .as_deref()
                .and_then(task_by_id)
                .map(|task| task.chapter.to_owned())
        })
        .unwrap_or_else(|| "foundation".to_owned());
    // Completed campaign tasks never consult their metric again: the loop
    // below only applies a previously deferred reward. Endgame factories have
    // every task completed, so rebuilding topology metrics from every entity
    // and belt once per simulated second was pure overhead. Keep the existing
    // scan for any save that still has a pending task, while making the common
    // completed-campaign path O(number of campaign tasks).
    let all_tasks_completed = TASKS.iter().all(|task| completed.contains(task.id));
    let factory_metrics = if all_tasks_completed {
        CampaignFactoryMetrics::default()
    } else {
        prepared_factory_metrics.unwrap_or_else(|| CampaignFactoryMetrics::collect(state, entities))
    };
    let completed_metrics = TASKS
        .iter()
        .map(|task| {
            if completed.contains(task.id) {
                return true;
            }
            let target = metric_target(task.metric).max(1.0);
            metric_value(base, &factory_metrics, task.metric)
                .floor()
                .clamp(0.0, target)
                >= target
        })
        .collect::<Vec<_>>();
    let mut changed = false;
    let mut progressed = true;
    while progressed {
        progressed = false;
        for (task_index, task) in TASKS.iter().enumerate() {
            if completed.contains(task.id) {
                if !rewarded.contains(task.id) && can_apply_rewards(base, task.rewards) {
                    for reward in task.rewards {
                        apply_reward(state, base, *reward)?;
                    }
                    rewarded.insert(task.id.to_owned());
                    rewarded_order.push(task.id.to_owned());
                    changed = true;
                }
                continue;
            }
            if !prerequisites_met(&completed, task) || !completed_metrics[task_index] {
                continue;
            }
            completed.insert(task.id.to_owned());
            completed_order.push(task.id.to_owned());
            progressed = true;
            changed = true;
            if can_apply_rewards(base, task.rewards) {
                for reward in task.rewards {
                    apply_reward(state, base, *reward)?;
                }
                rewarded.insert(task.id.to_owned());
                rewarded_order.push(task.id.to_owned());
            }
        }
    }
    let selected = normalized_active_task
        .as_deref()
        .and_then(task_by_id)
        .filter(|task| !completed.contains(task.id) && prerequisites_met(&completed, task));
    let pending = selected.or_else(|| first_pending_task(&completed));
    let active_task = pending.map(|task| task.id);
    let active_chapter = pending
        .map(|task| task.chapter)
        .unwrap_or(normalized_active_chapter.as_str());
    if normalized_active_task.as_deref() != active_task
        || normalized_active_chapter != active_chapter
    {
        changed = true;
    }
    if !changed {
        return Ok(());
    }
    let campaign = base
        .get_mut("campaign")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native campaign state is missing"))?;
    campaign.insert("activeChapterId".to_owned(), Value::from(active_chapter));
    campaign.insert(
        "activeTaskId".to_owned(),
        active_task.map(Value::from).unwrap_or(Value::Null),
    );
    campaign.insert(
        "completedTaskIds".to_owned(),
        Value::Array(completed_order.into_iter().map(Value::from).collect()),
    );
    campaign.insert(
        "rewardedTaskIds".to_owned(),
        Value::Array(rewarded_order.into_iter().map(Value::from).collect()),
    );
    Ok(())
}

pub(crate) fn synchronize_orbital_station_eligibility(
    base: &mut Map<String, Value>,
) -> anyhow::Result<()> {
    if base.get("mode").and_then(Value::as_str) != Some("normal")
        || number_in_record(base, "totalProduced", "universe_matrix") < 1.0
    {
        return Ok(());
    }
    let station = base
        .get_mut("orbitalStation")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native orbital station state is missing"))?;
    if string_at(station, "status") == Some("locked") {
        station.insert("status".to_owned(), Value::from("eligible"));
    }
    Ok(())
}

pub(crate) fn validate_state(base: &Map<String, Value>) -> anyhow::Result<()> {
    let campaign = base
        .get("campaign")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native campaign state is missing"))?;
    for key in ["completedTaskIds", "rewardedTaskIds"] {
        let values = campaign
            .get(key)
            .and_then(Value::as_array)
            .ok_or_else(|| anyhow!("native campaign task list is missing"))?;
        if values.iter().any(|value| value.as_str().is_none()) {
            bail!("native campaign task list is invalid");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deterministic_runtime::PARALLEL_MIN_ITEMS;
    use crate::simulation::{CoreAdvanceMode, CoreAdvanceRequest};
    use serde_json::json;
    use std::time::Instant;

    #[test]
    fn campaign_factory_probe_is_identical_at_every_worker_limit() {
        let entities = (0..(PARALLEL_MIN_ITEMS * 2 + 17))
            .map(|index| {
                if index % 17 == 0 {
                    return Value::Null;
                }
                json!({
                    "buildingId": if index % 3 == 0 { "mod-建筑" } else { "assembler" },
                    "machineCount": if index % 5 == 0 { 0.0 } else { (index % 7 + 1) as f64 },
                    "minerCount": (index % 11) as f64 / 8.0,
                    "stationTrips": (index % 13) as f64 / 16.0,
                    "sprayCoaterInstalled": index == PARALLEL_MIN_ITEMS + 3,
                })
            })
            .collect::<Vec<_>>();
        let belt_tiers = (0..(PARALLEL_MIN_ITEMS + 13))
            .map(|index| (index % 4) as u8)
            .collect::<Vec<_>>();
        let serial_started = Instant::now();
        let expected = CampaignFactoryMetrics::collect_with_runtime(
            &DeterministicRuntime::for_test(1),
            &belt_tiers,
            &entities,
        );
        let serial_micros = serial_started.elapsed().as_micros();
        assert!(expected.spray_coater_installed);
        assert!(expected.buildings.contains_key("mod-建筑"));
        let mut eight_worker_micros = 0;
        for worker_limit in [2, 4, 8] {
            let runtime = DeterministicRuntime::for_test(worker_limit);
            assert_eq!(runtime.worker_count_for_items(entities.len()), worker_limit);
            let started = Instant::now();
            let candidate =
                CampaignFactoryMetrics::collect_with_runtime(&runtime, &belt_tiers, &entities);
            if worker_limit == 8 {
                eight_worker_micros = started.elapsed().as_micros();
            }
            assert_eq!(
                candidate, expected,
                "campaign metrics diverged at {worker_limit} workers",
            );
        }

        let shared_started = Instant::now();
        let mut shared_history_probe = CampaignFactoryMetrics::default();
        for entity in entities.iter().filter_map(Value::as_object) {
            shared_history_probe.apply_entity_probe(campaign_entity_metric_probe(entity));
        }
        shared_history_probe.observe_belts(&belt_tiers);
        let shared_micros = shared_started.elapsed().as_micros();
        assert_eq!(shared_history_probe, expected);
        eprintln!(
            "campaign-factory-probe-synthetic\tentities={}\tbelts={}\tstandalone-1-worker-us={serial_micros}\tstandalone-8-worker-us={eight_worker_micros}\tordered-replay-us={shared_micros}",
            entities.len(),
            belt_tiers.len(),
        );
    }

    #[test]
    fn factory_metric_reuse_is_only_requested_for_an_incomplete_valid_campaign() {
        let incomplete = json!({
            "campaign": {
                "activeChapterId": "foundation",
                "activeTaskId": "mine_first_ore",
                "completedTaskIds": [],
                "rewardedTaskIds": []
            }
        });
        assert!(factory_metrics_needed(incomplete.as_object().unwrap()));

        let completed_ids = TASKS.iter().map(|task| task.id).collect::<Vec<_>>();
        let completed = json!({
            "campaign": {
                "activeChapterId": "endgame",
                "activeTaskId": null,
                "completedTaskIds": completed_ids,
                "rewardedTaskIds": []
            }
        });
        assert!(!factory_metrics_needed(completed.as_object().unwrap()));
        assert!(!factory_metrics_needed(
            json!({ "campaign": null }).as_object().unwrap()
        ));
    }

    #[test]
    fn completed_campaign_does_not_preload_factory_cache_until_workspace_open() {
        let completed_ids = TASKS.iter().map(|task| task.id).collect::<Vec<_>>();
        let mut base = crate::simple_factory::tests::construction_isolation_base();
        base["campaign"] = json!({
            "activeChapterId": "endgame",
            "activeTaskId": null,
            "completedTaskIds": completed_ids.clone(),
            "rewardedTaskIds": completed_ids
        });
        let mut state = crate::simple_factory::tests::fixture_state_from_base(base, &[]);
        assert_eq!(state.campaign_projection_runtime.estimated_bytes(), 0);

        let entities = state.parse_entities_parallel().unwrap();
        let cold_revision = state.revision + 1;
        let cold_update = state.campaign_projection_runtime.prepare_simulation_update(
            &state,
            &entities,
            Some(&[]),
            cold_revision,
        );
        assert!(cold_update.factory_metrics(&state).is_none());
        state
            .campaign_projection_runtime
            .install_simulation_update(cold_update);
        state.revision = cold_revision;
        assert_eq!(state.campaign_projection_runtime.estimated_bytes(), 0);
        assert_eq!(
            state.campaign_projection_runtime.diagnostics(),
            CampaignProjectionDiagnostics {
                mode: "invalidated",
                entity_rows_visited: 0,
                belt_rows_visited: 0,
                selected_worker_count: 0,
            }
        );

        state
            .campaign_workspace_projection(
                "authority-complete",
                "run-complete",
                state.revision,
                "machine-e3",
            )
            .unwrap();
        assert!(state.campaign_projection_runtime.estimated_bytes() > 0);
        assert_eq!(
            state.campaign_projection_runtime.diagnostics().mode,
            "flat-full-cached"
        );
        let warm_bytes = state.campaign_projection_runtime.estimated_bytes();
        let warm_revision = state.revision + 1;
        let warm_update = state.campaign_projection_runtime.prepare_simulation_update(
            &state,
            &entities,
            Some(&[]),
            warm_revision,
        );
        assert!(warm_update.factory_metrics(&state).is_some());
        state
            .campaign_projection_runtime
            .install_simulation_update(warm_update);
        state.revision = warm_revision;
        assert_eq!(
            state.campaign_projection_runtime.estimated_bytes(),
            warm_bytes
        );
        assert_eq!(
            state.campaign_projection_runtime.diagnostics(),
            CampaignProjectionDiagnostics {
                mode: "incremental-update",
                entity_rows_visited: 0,
                belt_rows_visited: 0,
                selected_worker_count: 0,
            }
        );
    }

    #[test]
    fn campaign_workspace_projection_is_bound_bounded_and_read_only() {
        let mut state = crate::simple_factory::tests::fixture_state(&[]);
        state.base_value_mut().insert(
            "campaign".to_owned(),
            json!({
                "activeChapterId": "foundation",
                "activeTaskId": "mine_first_ore",
                "completedTaskIds": [],
                "rewardedTaskIds": []
            }),
        );
        let before = state.canonical_sha256().unwrap();
        let memory_before = state.summary().unwrap().memory.estimated_runtime_bytes;
        let projection = state
            .campaign_workspace_projection("authority-1", "run-1", state.revision, "machine-e3")
            .unwrap();
        assert_eq!(
            state.campaign_projection_runtime.diagnostics().mode,
            "flat-full-cached"
        );
        let memory_after = state.summary().unwrap().memory.estimated_runtime_bytes;
        assert!(memory_after > memory_before);
        assert!(state.campaign_projection_runtime.estimated_bytes() > 0);
        let cloned = state.clone();
        assert_eq!(cloned.campaign_projection_runtime.estimated_bytes(), 0);
        assert!(state.campaign_projection_runtime.estimated_bytes() > 0);
        let cached_projection = state
            .campaign_workspace_projection("authority-1", "run-1", state.revision, "machine-e3")
            .unwrap();
        assert_eq!(cached_projection, projection);
        assert_eq!(
            state.campaign_projection_runtime.diagnostics(),
            CampaignProjectionDiagnostics {
                mode: "same-revision-cache",
                entity_rows_visited: 0,
                belt_rows_visited: 0,
                selected_worker_count: 0,
            }
        );
        assert_eq!(projection["projectionType"], "campaign-workspace-v1");
        assert_eq!(projection["sessionId"], "authority-1");
        assert_eq!(projection["runId"], "run-1");
        assert_eq!(projection["revision"], state.revision);
        assert_eq!(projection["registryFingerprint"], "machine-e3");
        assert_eq!(projection["truncated"], false);
        assert_eq!(projection["counts"]["chapters"], CHAPTERS.len());
        assert_eq!(projection["counts"]["tasks"], TASKS.len());
        assert!(serde_json::to_vec(&projection).unwrap().len() <= MAX_CAMPAIGN_WORKSPACE_BYTES);
        let encoded = serde_json::to_string(&projection).unwrap();
        for forbidden in [
            "entities",
            "belts",
            "tray",
            "construction",
            "quantumLogisticsNetwork",
            "inputs",
            "outputs",
        ] {
            assert!(!encoded.contains(forbidden), "leaked {forbidden}");
        }
        assert_eq!(state.canonical_sha256().unwrap(), before);
        assert!(
            state
                .campaign_workspace_projection(
                    "authority-1",
                    "run-1",
                    state.revision + 1,
                    "machine-e3"
                )
                .is_err()
        );
        assert!(
            state
                .campaign_workspace_projection("authority-1", "run-1", state.revision, "stale")
                .is_err()
        );
    }

    #[test]
    fn campaign_projection_sparse_revisions_match_the_flat_oracle_at_1_5_and_60_seconds() {
        let source_entities = (0..257)
            .map(|index| {
                if index == 0 {
                    json!({
                        "id": "campaign-active-machine",
                        "kind": "machine",
                        "planetId": "home",
                        "powerGridId": "grid-a",
                        "buildingId": "arc_smelter",
                        "recipeId": "iron_ingot",
                        "machineCount": 1,
                        "minerCount": 0,
                        "inputs": { "iron_ore": 1000, "proliferator_mk1": 0 },
                        "outputs": { "iron_ingot": 0 },
                        "progress": 0,
                        "utilization": 0,
                        "productionRate": 0,
                        "routingCursor": 0,
                        "proliferatorBonusProgress": {}
                    })
                } else {
                    json!({
                        "id": format!("campaign-cold-storage-{index:04}"),
                        "kind": "storage",
                        "planetId": "home",
                        "powerGridId": "grid-a",
                        "buildingId": "storage_mk1",
                        "recipeId": null,
                        "storedItemId": "iron_ingot",
                        "machineCount": 1,
                        "minerCount": 0,
                        "inputs": {},
                        "outputs": {},
                        "progress": 0,
                        "utilization": 0,
                        "productionRate": 0,
                        "routingCursor": 0,
                        "stationTrips": 0
                    })
                }
            })
            .collect::<Vec<_>>();
        for seconds in [1.0, 5.0, 60.0] {
            let mut state = crate::simple_factory::tests::fixture_state_from_base(
                crate::simple_factory::tests::construction_isolation_base(),
                &source_entities,
            );
            state
                .campaign_workspace_projection(
                    "authority-sparse",
                    "run-sparse",
                    state.revision,
                    "machine-e3",
                )
                .unwrap();
            let previous_revision = state.revision;
            let result = state
                .advance(&CoreAdvanceRequest {
                    base_revision: previous_revision,
                    simulation_seconds: seconds,
                    wall_seconds: seconds,
                    advance_mode: CoreAdvanceMode::Exact,
                    include_diagnostics: false,
                })
                .unwrap();
            assert!(result.supported, "{seconds}s: {:?}", result.reason);
            assert!(state.revision > previous_revision);
            let update = state.campaign_projection_runtime.diagnostics();
            assert_eq!(update.mode, "incremental-update", "{seconds}s");
            assert!(
                update.entity_rows_visited < source_entities.len(),
                "{seconds}s visited {} of {} rows",
                update.entity_rows_visited,
                source_entities.len()
            );
            assert_eq!(update.belt_rows_visited, 0);

            let flat = state.clone();
            let incremental_projection = state
                .campaign_workspace_projection(
                    "authority-sparse",
                    "run-sparse",
                    state.revision,
                    "machine-e3",
                )
                .unwrap();
            let flat_projection = flat
                .campaign_workspace_projection(
                    "authority-sparse",
                    "run-sparse",
                    flat.revision,
                    "machine-e3",
                )
                .unwrap();
            assert_eq!(
                serde_json::to_vec(&incremental_projection).unwrap(),
                serde_json::to_vec(&flat_projection).unwrap(),
                "{seconds}s"
            );
            assert_eq!(
                state.canonical_sha256().unwrap(),
                flat.canonical_sha256().unwrap()
            );
        }
    }

    #[test]
    fn campaign_station_trip_writers_patch_only_the_reported_rows_and_topology_fails_closed() {
        let station = |id: &str, trips: u64| {
            json!({
                "id": id,
                "kind": "station",
                "planetId": "home",
                "powerGridId": "grid-a",
                "buildingId": "interstellar_logistics_station",
                "machineCount": 1,
                "minerCount": 0,
                "stationTrips": trips,
                "inputs": {},
                "outputs": {},
                "stationRoutes": []
            })
        };
        let mut state = crate::simple_factory::tests::fixture_state(&[
            station("campaign-station-a", 10),
            station("campaign-station-b", 20),
            json!({
                "id": "campaign-unrelated-storage",
                "kind": "storage",
                "planetId": "home",
                "buildingId": "storage_mk1",
                "machineCount": 1,
                "minerCount": 0,
                "inputs": {},
                "outputs": {}
            }),
        ]);
        state.base_value_mut().insert(
            "campaign".to_owned(),
            json!({
                "activeChapterId": "foundation",
                "activeTaskId": "mine_first_ore",
                "completedTaskIds": [],
                "rewardedTaskIds": []
            }),
        );
        state
            .campaign_workspace_projection(
                "authority-writer",
                "run-writer",
                state.revision,
                "machine-e3",
            )
            .unwrap();
        let mut next_entities = state.parse_entities_parallel().unwrap();
        next_entities[0]["stationTrips"] = Value::from(11);
        next_entities[1]["stationTrips"] = Value::from(22);
        let next_revision = state.revision + 1;
        let update = state.campaign_projection_runtime.prepare_simulation_update(
            &state,
            &next_entities,
            Some(&[0, 1]),
            next_revision,
        );
        state
            .campaign_projection_runtime
            .install_simulation_update(update);
        assert_eq!(
            state.campaign_projection_runtime.diagnostics(),
            CampaignProjectionDiagnostics {
                mode: "incremental-update",
                entity_rows_visited: 2,
                belt_rows_visited: 0,
                selected_worker_count: 0,
            }
        );
        state.revision = next_revision;
        let indexed = state
            .campaign_projection_runtime
            .snapshot(&state, &DeterministicRuntime::for_test(1))
            .unwrap();
        let flat = CampaignFactoryMetrics::collect(&state, &next_entities);
        assert_eq!(indexed, flat);
        assert_eq!(
            metric_value(
                state.base_value(),
                &indexed,
                Metric::StationTrips("interstellar_logistics_station", 1.0),
            ),
            33.0
        );

        let reset = state.campaign_projection_runtime.prepare_simulation_update(
            &state,
            &next_entities,
            None,
            state.revision + 1,
        );
        state
            .campaign_projection_runtime
            .install_simulation_update(reset);
        assert_eq!(
            state.campaign_projection_runtime.diagnostics().mode,
            "invalidated"
        );
        assert_eq!(state.campaign_projection_runtime.estimated_bytes(), 0);
    }

    #[test]
    fn unsupported_fractional_metric_lineage_skips_repeated_revision_rebuilds() {
        let mut base = crate::simple_factory::tests::construction_isolation_base();
        base["campaign"] = json!({
            "activeChapterId": "foundation",
            "activeTaskId": "mine_first_ore",
            "completedTaskIds": [],
            "rewardedTaskIds": []
        });
        let mut state = crate::simple_factory::tests::fixture_state_from_base(
            base,
            &[json!({
                "id": "campaign-fractional-mod-station",
                "kind": "station",
                "planetId": "home",
                "powerGridId": "grid-a",
                "buildingId": "interstellar_logistics_station",
                "machineCount": 1,
                "minerCount": 0,
                "stationTrips": 0.5,
                "inputs": {},
                "outputs": {},
                "stationRoutes": []
            })],
        );
        assert_eq!(
            state.campaign_projection_runtime.diagnostics().mode,
            "opened-unsupported"
        );
        assert!(state.campaign_projection_runtime.estimated_bytes() > 0);
        let entities = state.parse_entities_parallel().unwrap();

        for _ in 0..2 {
            let next_revision = state.revision + 1;
            let update = state.campaign_projection_runtime.prepare_simulation_update(
                &state,
                &entities,
                Some(&[]),
                next_revision,
            );
            assert!(update.factory_metrics(&state).is_none());
            state
                .campaign_projection_runtime
                .install_simulation_update(update);
            assert_eq!(
                state.campaign_projection_runtime.diagnostics(),
                CampaignProjectionDiagnostics {
                    mode: "unsupported-fast-path",
                    entity_rows_visited: 0,
                    belt_rows_visited: 0,
                    selected_worker_count: 0,
                }
            );
            state.revision = next_revision;
        }
    }
}
