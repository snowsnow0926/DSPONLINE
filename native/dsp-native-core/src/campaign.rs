use std::collections::{BTreeMap, HashMap, HashSet};

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

fn number_in_record(base: &Map<String, Value>, record: &str, key: &str) -> f64 {
    base.get(record)
        .and_then(Value::as_object)
        .and_then(|values| values.get(key))
        .map(|value| finite_number(Some(value)))
        .unwrap_or(0.0)
}

#[derive(Debug, Default, PartialEq)]
struct CampaignBuildingMetrics {
    count: f64,
    station_trips: f64,
}

#[derive(Debug, Default, PartialEq)]
pub(crate) struct CampaignFactoryMetrics {
    buildings: HashMap<String, CampaignBuildingMetrics>,
    miner_count: f64,
    belt_counts_by_minimum_tier: HashMap<u8, f64>,
    spray_coater_installed: bool,
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
}
