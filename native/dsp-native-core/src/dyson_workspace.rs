//! Revision-bound read model for the player-visible Dyson workspace.
//!
//! The projection is deliberately independent from renderer `GameState`.
//! Every page is derived from one committed native `CoreState`, echoes the
//! exact session identity supplied by the host, and remains below the 1 MiB
//! renderer transfer ceiling. Large plan arrays are flattened and paged; no
//! public save field or runtime cache is added by this module.

#![allow(clippy::items_after_test_module)]

use std::collections::{BTreeSet, HashMap, HashSet};

use anyhow::{anyhow, bail};
use serde_json::{Map, Value, json};

use crate::state::CoreState;

const DYSON_WORKSPACE_SCHEMA: &str = "dyson-workspace-v1";
const MAX_REQUEST_BYTES: usize = 32_768;
const MAX_PROJECTION_BYTES: usize = 1_048_576;
const MAX_PAGE_ROWS: usize = 64;
const MAX_TOTAL_ROWS: usize = 65_536;
const MAX_ID_BYTES: usize = 1_024;
const MAX_LABEL_BYTES: usize = 512;
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
const EPSILON: f64 = 0.0001;
const SOLAR_SAIL_POWER_KW: f64 = 88.0;
const RAY_RECEIVER_CAPACITY_KW: f64 = 6_000.0;
const DYSON_STRUCTURE_POWER_KW: f64 = 960.0;
const DYSON_SHELL_SAIL_POWER_KW: f64 = 88.0;
const DYSON_SHELL_CAPACITY_PER_STRUCTURE: f64 = 40.0;
const DYSON_SAIL_LAUNCH_ENERGY_MJ: f64 = 21.6;
const DYSON_ROCKET_LAUNCH_ENERGY_MJ: f64 = 108.0;

#[derive(Debug, Clone)]
struct PlanRows {
    active_layer_id: Option<String>,
    structure_points: f64,
    shell_sails: f64,
    layers: Vec<Value>,
    nodes: Vec<Value>,
    frames: Vec<Value>,
    shells: Vec<Value>,
    planned_structure: f64,
    completed_structure: f64,
    sail_capacity: f64,
    absorbed_sails: f64,
}

impl Default for PlanRows {
    fn default() -> Self {
        Self {
            active_layer_id: None,
            structure_points: 0.0,
            shell_sails: 0.0,
            layers: Vec::new(),
            nodes: Vec::new(),
            frames: Vec::new(),
            shells: Vec::new(),
            planned_structure: 0.0,
            completed_structure: 0.0,
            sail_capacity: 0.0,
            absorbed_sails: 0.0,
        }
    }
}

#[derive(Debug, Clone)]
struct OrbitRows {
    active_orbit_id: Option<String>,
    rows: Vec<Value>,
    sails_in_orbit: f64,
    total_launched: f64,
    total_expired: f64,
    generation_kw: f64,
}

impl Default for OrbitRows {
    fn default() -> Self {
        Self {
            active_orbit_id: None,
            rows: Vec::new(),
            sails_in_orbit: 0.0,
            total_launched: 0.0,
            total_expired: 0.0,
            generation_kw: 0.0,
        }
    }
}

fn object_at<'a>(base: &'a Map<String, Value>, key: &str) -> Option<&'a Map<String, Value>> {
    base.get(key).and_then(Value::as_object)
}

fn nested_object<'a>(
    object: Option<&'a Map<String, Value>>,
    key: &str,
) -> Option<&'a Map<String, Value>> {
    object?.get(key).and_then(Value::as_object)
}

fn valid_opaque_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_ID_BYTES
        && !value.chars().any(char::is_control)
        && !value
            .chars()
            .any(|character| (0xd800..=0xdfff).contains(&(character as u32)))
}

fn opaque_id<'a>(value: Option<&'a Value>, label: &str) -> anyhow::Result<&'a str> {
    value
        .and_then(Value::as_str)
        .filter(|value| valid_opaque_id(value))
        .ok_or_else(|| anyhow!("native Dyson workspace {label} is invalid"))
}

fn optional_opaque_id(value: Option<&Value>, label: &str) -> anyhow::Result<Option<String>> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(value) => Ok(Some(opaque_id(Some(value), label)?.to_owned())),
    }
}

fn bounded_label(candidate: Option<&str>, fallback: &str) -> (String, bool) {
    let source = candidate
        .filter(|value| !value.is_empty() && !value.chars().any(char::is_control))
        .unwrap_or(fallback);
    if source.len() <= MAX_LABEL_BYTES {
        return (source.to_owned(), false);
    }
    let mut output = String::with_capacity(MAX_LABEL_BYTES);
    for character in source.chars() {
        if output.len() + character.len_utf8() > MAX_LABEL_BYTES {
            break;
        }
        output.push(character);
    }
    (output, true)
}

fn finite_number(value: Option<&Value>, label: &str) -> anyhow::Result<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .ok_or_else(|| anyhow!("native Dyson workspace {label} is invalid"))
}

fn finite_number_or(value: Option<&Value>, fallback: f64, label: &str) -> anyhow::Result<f64> {
    match value {
        None | Some(Value::Null) => Ok(fallback),
        Some(_) => finite_number(value, label),
    }
}

fn non_negative_number(value: Option<&Value>, label: &str) -> anyhow::Result<f64> {
    let value = finite_number(value, label)?;
    if !(0.0..=MAX_SAFE_INTEGER).contains(&value) {
        bail!("native Dyson workspace {label} is outside the safe range");
    }
    Ok(value.max(0.0))
}

fn non_negative_integer(value: Option<&Value>, label: &str) -> anyhow::Result<f64> {
    let value = non_negative_number(value, label)?;
    if value.fract() != 0.0 {
        bail!("native Dyson workspace {label} is not an integer");
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use serde_json::{Map, Value, json};

    use super::*;
    use crate::catalog::{
        BeltDefinition, BuildingDefinition, CatalogSnapshot, ItemAmount, ItemDefinition,
        PlanetDefinition, RecipeDefinition, RuntimeCatalog, TechnologyDefinition,
    };
    use crate::state::CoreCheckpointIdentity;

    const FINGERPRINT: &str = "dyson-workspace-test";

    fn item(id: &str) -> ItemDefinition {
        ItemDefinition {
            id: id.to_owned(),
            name: id.to_owned(),
            kind: "solid".to_owned(),
            fuel_energy_mj: 0.0,
        }
    }

    fn building(id: &str, kind: &str, speed: f64, output_capacity: f64) -> BuildingDefinition {
        BuildingDefinition {
            id: id.to_owned(),
            kind: kind.to_owned(),
            speed,
            input_capacity: 100.0,
            output_capacity,
            power_demand_kw: 0.0,
            power_generation_kw: 0.0,
            power_charge_kw: 0.0,
            energy_capacity_mj: 0.0,
            fuel_item_ids: Vec::new(),
            fuel_efficiency: 1.0,
            family: None,
            accepts: None,
        }
    }

    fn recipe(
        id: &str,
        building_id: &str,
        duration: f64,
        required_tech_id: Option<&str>,
        inputs: Vec<ItemAmount>,
        outputs: Vec<ItemAmount>,
    ) -> RecipeDefinition {
        RecipeDefinition {
            id: id.to_owned(),
            name: id.to_owned(),
            building_id: building_id.to_owned(),
            duration,
            required_tech_id: required_tech_id.map(str::to_owned),
            recursive_priority: 0.0,
            recursive_manufacturing: false,
            inputs,
            outputs,
        }
    }

    fn amount(item_id: &str, amount: f64) -> ItemAmount {
        ItemAmount {
            item_id: item_id.to_owned(),
            amount,
        }
    }

    fn fixture_catalog() -> RuntimeCatalog {
        RuntimeCatalog::validate(
            CatalogSnapshot {
                protocol_version: 1,
                registry_fingerprint: FINGERPRINT.to_owned(),
                planets: vec![
                    PlanetDefinition {
                        id: "home".to_owned(),
                        name: "Home".to_owned(),
                        system_id: "helios".to_owned(),
                        kind: "terrestrial".to_owned(),
                        orbit_index: 1,
                        simulation_order: 0,
                        orbital_yields: HashMap::new(),
                    },
                    PlanetDefinition {
                        id: "ice".to_owned(),
                        name: "Ice".to_owned(),
                        system_id: "borealis".to_owned(),
                        kind: "terrestrial".to_owned(),
                        orbit_index: 1,
                        simulation_order: 1,
                        orbital_yields: HashMap::new(),
                    },
                ],
                items: [
                    "solar_sail",
                    "small_carrier_rocket",
                    "critical_photon",
                    "antimatter",
                ]
                .into_iter()
                .map(item)
                .collect(),
                buildings: vec![
                    building("em_rail_ejector", "machine", 2.0, 100.0),
                    building("vertical_launching_silo", "machine", 1.0, 100.0),
                    building("ray_receiver", "machine", 1.0, 100.0),
                    building("miniature_particle_collider", "machine", 1.0, 100.0),
                    building("artificial_star", "power", 1.0, 0.0),
                ],
                recipes: vec![
                    recipe(
                        "solar_sail_launch",
                        "em_rail_ejector",
                        6.0,
                        Some("dyson_swarm"),
                        vec![amount("solar_sail", 1.0)],
                        Vec::new(),
                    ),
                    recipe(
                        "carrier_rocket_launch",
                        "vertical_launching_silo",
                        10.0,
                        Some("dyson_sphere_program"),
                        vec![amount("small_carrier_rocket", 1.0)],
                        Vec::new(),
                    ),
                    recipe(
                        "ray_power",
                        "ray_receiver",
                        1.0,
                        None,
                        Vec::new(),
                        Vec::new(),
                    ),
                    recipe(
                        "critical_photon",
                        "ray_receiver",
                        2.0,
                        Some("dirac_inversion"),
                        Vec::new(),
                        vec![amount("critical_photon", 1.0)],
                    ),
                    recipe(
                        "antimatter",
                        "miniature_particle_collider",
                        2.0,
                        None,
                        vec![amount("critical_photon", 2.0)],
                        vec![amount("antimatter", 2.0)],
                    ),
                ],
                constructions: Vec::new(),
                belts: vec![BeltDefinition {
                    tier: 1,
                    speed: 6.0,
                }],
                proliferators: Vec::new(),
                technologies: [
                    "dyson_sphere_program",
                    "dyson_shell",
                    "dyson_swarm",
                    "dirac_inversion",
                    "ray_transmission_1",
                ]
                .into_iter()
                .map(|id| TechnologyDefinition {
                    id: id.to_owned(),
                    name: id.to_owned(),
                    costs: vec![amount("solar_sail", 1.0)],
                    prerequisites: Vec::new(),
                    construction_rewards: Vec::new(),
                })
                .collect(),
            },
            FINGERPRINT,
        )
        .unwrap()
    }

    fn fixture_base() -> Map<String, Value> {
        json!({
            "version": 47,
            "mode": "normal",
            "activePlanetId": "home",
            "settings": { "productionBufferLimit": 1000 },
            "research": {
                "selectedTechId": null,
                "pausedTechId": null,
                "queuedTechIds": [],
                "progressByTech": {},
                "completedTechIds": [
                    "dyson_sphere_program",
                    "dyson_shell",
                    "dyson_swarm",
                    "dirac_inversion",
                    "ray_transmission_1"
                ]
            },
            "endgame": {
                "infiniteResearch": {
                    "stellar_harnessing": { "level": 2, "progress": "0" }
                }
            },
            "exploration": {
                "unlockedSystemIds": ["helios", "borealis", "mod:星系/Ω🚀"]
            },
            "galaxy": {
                "systemProfiles": {
                    "helios": {
                        "starTypeName": "G 型恒星",
                        "luminosity": 1.0,
                        "radiusMultiplier": 1.0
                    },
                    "borealis": {
                        "starTypeName": "B",
                        "luminosity": 1.5,
                        "radiusMultiplier": 1.25
                    }
                },
                "systemMetadata": {
                    "helios": { "customName": "太阳系 🚀" }
                }
            },
            "dysonPlans": {
                "helios": {
                    "systemId": "helios",
                    "structurePoints": 20,
                    "shellSails": 5,
                    "activeLayerId": "layer:主层/一",
                    "layers": [{
                        "id": "layer:主层/一",
                        "name": "主层 Ω",
                        "radius": 10000,
                        "inclination": 15,
                        "longitude": 45,
                        "structureAllocationFloor": 3,
                        "shellAllocationFloor": 2,
                        "nodes": [
                            { "id": "node:a", "angle": 0, "requiredStructurePoints": 5, "completedStructurePoints": 5 },
                            { "id": "node:b", "angle": 180, "requiredStructurePoints": 5, "completedStructurePoints": 5 }
                        ],
                        "frames": [{
                            "id": "frame:a-b",
                            "sourceNodeId": "node:a",
                            "targetNodeId": "node:b",
                            "requiredStructurePoints": 10,
                            "completedStructurePoints": 10
                        }],
                        "shells": [{
                            "id": "shell:a-b",
                            "sourceNodeId": "node:a",
                            "targetNodeId": "node:b",
                            "boundaryFrameIds": ["frame:a-b"],
                            "sailCapacity": 10,
                            "absorbedSails": 5
                        }]
                    }]
                },
                "borealis": {
                    "systemId": "borealis",
                    "structurePoints": 0,
                    "shellSails": 0,
                    "activeLayerId": null,
                    "layers": []
                }
            },
            "dysonEngineering": {
                "launchMode": "balanced",
                "launchThrottle": 0.5,
                "launchEnabled": true,
                "launchEnergySpentMj": 4321,
                "activeOrbitBySystem": { "helios": "orbit:轨道/一" },
                "orbitsBySystem": {
                    "helios": [{
                        "id": "orbit:轨道/一",
                        "name": "轨道一 🚀",
                        "radius": 12000,
                        "inclination": -5,
                        "longitude": 90,
                        "sailsInOrbit": 30,
                        "totalLaunched": 42,
                        "totalExpired": 7,
                        "decayProgress": 0.25,
                        "generationKw": 0
                    }],
                    "borealis": []
                }
            },
            "dysonSphere": {
                "structurePoints": 20,
                "totalRocketsLaunched": 25,
                "shellSails": 5,
                "totalSailsAbsorbed": 5,
                "absorptionProgress": 0,
                "generationKw": 0
            },
            "dysonSwarm": {
                "sailsInOrbit": 30,
                "totalLaunched": 42,
                "totalExpired": 7,
                "decayProgress": 0,
                "generationKw": 0,
                "receiverLoadKw": 6000
            }
        })
        .as_object()
        .unwrap()
        .clone()
    }

    fn fixture_entities() -> Vec<String> {
        [
            json!({
                "id": "ejector:一", "kind": "machine", "planetId": "home",
                "buildingId": "em_rail_ejector", "recipeId": "solar_sail_launch",
                "machineCount": 2, "inputs": { "solar_sail": 12 }, "outputs": {},
                "productionRate": 0, "powerOutputKw": 0, "targetDysonOrbitId": "orbit:轨道/一"
            }),
            json!({
                "id": "silo:一", "kind": "machine", "planetId": "home",
                "buildingId": "vertical_launching_silo", "recipeId": "carrier_rocket_launch",
                "machineCount": 3, "inputs": { "small_carrier_rocket": 6 }, "outputs": {},
                "productionRate": 0, "powerOutputKw": 0
            }),
            json!({
                "id": "receiver:一", "kind": "machine", "planetId": "home",
                "buildingId": "ray_receiver", "recipeId": "critical_photon",
                "machineCount": 2, "inputs": {}, "outputs": { "critical_photon": 4 },
                "productionRate": 20, "powerOutputKw": 5000
            }),
            json!({
                "id": "collider:一", "kind": "machine", "planetId": "home",
                "buildingId": "miniature_particle_collider", "recipeId": "antimatter",
                "machineCount": 1, "inputs": {}, "outputs": { "antimatter": 2 },
                "productionRate": 8, "powerOutputKw": 0
            }),
            json!({
                "id": "star:一", "kind": "power", "planetId": "home",
                "buildingId": "artificial_star", "recipeId": null,
                "machineCount": 1, "inputs": {}, "outputs": {},
                "productionRate": 0, "powerOutputKw": 25000
            }),
        ]
        .into_iter()
        .map(|entity| entity.to_string())
        .collect()
    }

    fn fixture_state_with(base: Map<String, Value>) -> CoreState {
        CoreState::from_public_v47_parts(
            CoreCheckpointIdentity {
                slot: "normal-main".to_owned(),
                generation: 1,
                root_hash: "a".repeat(64),
                revision: 17,
                state_version: 47,
                mode: "normal".to_owned(),
                registry_fingerprint: FINGERPRINT.to_owned(),
                base_primary_checksum: "12345678".to_owned(),
            },
            base,
            fixture_entities(),
            Vec::new(),
            fixture_catalog(),
        )
        .unwrap()
    }

    fn fixture_state() -> CoreState {
        fixture_state_with(fixture_base())
    }

    fn projection(state: &CoreState, selected: &str, cursor: usize, limit: usize) -> Value {
        state
            .dyson_workspace_projection(
                17,
                FINGERPRINT,
                selected,
                cursor,
                limit,
                0,
                limit,
                0,
                limit,
                0,
                limit,
                0,
                limit,
                0,
                limit,
            )
            .unwrap()
    }

    #[test]
    fn projection_is_read_only_bounded_and_exposes_player_visible_dyson_state() {
        let state = fixture_state();
        let before = state.summary().unwrap().canonical_sha256;
        let value = projection(&state, "helios", 0, 1);

        assert_eq!(value["projectionType"], DYSON_WORKSPACE_SCHEMA);
        assert_eq!(value["revision"], 17);
        assert_eq!(value["registryFingerprint"], FINGERPRINT);
        assert_eq!(value["activePlanetId"], "home");
        assert_eq!(value["activeSystemId"], "helios");
        assert_eq!(value["technology"]["programReady"], true);
        assert_eq!(value["global"]["sphere"]["structurePoints"], 20.0);
        assert_eq!(value["global"]["sphere"]["totalRocketsLaunched"], 25.0);
        assert_eq!(value["global"]["swarm"]["sailsInOrbit"], 30.0);
        assert_eq!(value["summary"]["systemCount"], 3);
        assert_eq!(value["systems"]["rows"].as_array().unwrap().len(), 1);
        assert_eq!(value["systems"]["nextCursor"], 1);
        assert_eq!(value["selectedSystem"]["displayName"], "太阳系 🚀");
        assert_eq!(value["selectedSystem"]["totals"]["nodeCount"], 2);
        assert_eq!(value["selectedSystem"]["engineering"]["queuedSails"], 12.0);
        assert_eq!(value["selectedSystem"]["engineering"]["queuedRockets"], 6.0);
        assert_eq!(
            value["selectedSystem"]["engineering"]["criticalPhotonPerMinute"],
            20.0
        );
        assert_eq!(
            value["selectedSystem"]["engineering"]["antimatterPerMinute"],
            4.0
        );
        assert_eq!(
            value["selectedSystem"]["engineering"]["feedbackGenerationKw"],
            25_000.0
        );
        assert_eq!(value["layers"]["totalCount"], 1);
        assert_eq!(value["orbits"]["rows"][0]["orbitId"], "orbit:轨道/一");
        assert_eq!(value["nodes"]["totalCount"], 2);
        assert_eq!(value["frames"]["totalCount"], 1);
        assert_eq!(value["shells"]["rows"][0]["boundaryFrameCount"], 1);
        assert!(serde_json::to_vec(&value).unwrap().len() <= MAX_PROJECTION_BYTES);
        assert_eq!(state.summary().unwrap().canonical_sha256, before);
    }

    #[test]
    fn projection_pages_independently_and_preserves_unknown_utf8_system_ids() {
        let state = fixture_state();
        let first = projection(&state, "mod:星系/Ω🚀", 0, 2);
        let second = projection(&state, "mod:星系/Ω🚀", 2, 2);

        assert_eq!(first["selectedSystem"]["systemId"], "mod:星系/Ω🚀");
        assert_eq!(first["selectedSystem"]["starProfile"]["available"], false);
        assert_eq!(first["selectedSystem"]["structurePoints"], 0.0);
        assert_eq!(first["systems"]["rows"].as_array().unwrap().len(), 2);
        assert_eq!(first["systems"]["nextCursor"], 2);
        assert_eq!(second["systems"]["rows"].as_array().unwrap().len(), 1);
        assert_eq!(second["systems"]["rows"][0]["systemId"], "mod:星系/Ω🚀");
        assert!(second["systems"]["nextCursor"].is_null());
        assert_eq!(first, projection(&state, "mod:星系/Ω🚀", 0, 2));
    }

    #[test]
    fn projection_truncates_long_utf8_labels_on_scalar_boundaries() {
        let mut base = fixture_base();
        let metadata = base["galaxy"]["systemMetadata"].as_object_mut().unwrap();
        metadata.get_mut("helios").unwrap()["customName"] = Value::String("界".repeat(300));
        let value = projection(&fixture_state_with(base), "helios", 0, 4);
        let label = value["selectedSystem"]["displayName"].as_str().unwrap();
        assert!(label.len() <= MAX_LABEL_BYTES);
        assert_eq!(label.len() % "界".len(), 0);
        assert_eq!(value["selectedSystem"]["displayNameTruncated"], true);
    }

    #[test]
    fn projection_rejects_stale_identity_and_unbounded_or_invalid_requests() {
        let state = fixture_state();
        assert!(
            state
                .dyson_workspace_projection(
                    16,
                    FINGERPRINT,
                    "helios",
                    0,
                    1,
                    0,
                    1,
                    0,
                    1,
                    0,
                    1,
                    0,
                    1,
                    0,
                    1
                )
                .is_err()
        );
        assert!(
            state
                .dyson_workspace_projection(
                    17, "stale", "helios", 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1
                )
                .is_err()
        );
        assert!(
            state
                .dyson_workspace_projection(
                    17,
                    FINGERPRINT,
                    "unknown",
                    0,
                    1,
                    0,
                    1,
                    0,
                    1,
                    0,
                    1,
                    0,
                    1,
                    0,
                    1
                )
                .is_err()
        );
        assert!(
            state
                .dyson_workspace_projection(
                    17,
                    FINGERPRINT,
                    "bad\nidentifier",
                    0,
                    1,
                    0,
                    1,
                    0,
                    1,
                    0,
                    1,
                    0,
                    1,
                    0,
                    1
                )
                .is_err()
        );
        assert!(
            state
                .dyson_workspace_projection(
                    17,
                    FINGERPRINT,
                    "helios",
                    0,
                    MAX_PAGE_ROWS + 1,
                    0,
                    1,
                    0,
                    1,
                    0,
                    1,
                    0,
                    1,
                    0,
                    1
                )
                .is_err()
        );
        assert!(
            state
                .dyson_workspace_projection(
                    17,
                    FINGERPRINT,
                    "helios",
                    4,
                    1,
                    0,
                    1,
                    0,
                    1,
                    0,
                    1,
                    0,
                    1,
                    0,
                    1
                )
                .is_err()
        );
    }

    #[test]
    fn projection_fails_closed_on_broken_plan_and_global_conservation() {
        let mut bad_reference = fixture_base();
        bad_reference["dysonPlans"]["helios"]["layers"][0]["frames"][0]["targetNodeId"] =
            Value::String("missing-node".to_owned());
        assert!(
            fixture_state_with(bad_reference)
                .dyson_workspace_projection(
                    17,
                    FINGERPRINT,
                    "helios",
                    0,
                    2,
                    0,
                    2,
                    0,
                    2,
                    0,
                    2,
                    0,
                    2,
                    0,
                    2
                )
                .is_err()
        );

        let mut bad_conservation = fixture_base();
        bad_conservation["dysonSwarm"]["totalLaunched"] = Value::from(41);
        assert!(
            fixture_state_with(bad_conservation)
                .dyson_workspace_projection(
                    17,
                    FINGERPRINT,
                    "helios",
                    0,
                    2,
                    0,
                    2,
                    0,
                    2,
                    0,
                    2,
                    0,
                    2,
                    0,
                    2
                )
                .is_err()
        );

        let mut bad_sphere = fixture_base();
        bad_sphere["dysonSphere"]["structurePoints"] = Value::from(21);
        assert!(
            fixture_state_with(bad_sphere)
                .dyson_workspace_projection(
                    17,
                    FINGERPRINT,
                    "helios",
                    0,
                    2,
                    0,
                    2,
                    0,
                    2,
                    0,
                    2,
                    0,
                    2,
                    0,
                    2
                )
                .is_err()
        );
    }

    #[test]
    fn projection_preserves_historical_shell_sails_after_plan_capacity_edits() {
        let mut base = fixture_base();
        base["dysonPlans"]["helios"]["shellSails"] = Value::from(15);
        base["dysonSphere"]["shellSails"] = Value::from(15);
        base["dysonSphere"]["totalSailsAbsorbed"] = Value::from(15);
        base["dysonEngineering"]["orbitsBySystem"]["helios"][0]["totalLaunched"] = Value::from(52);
        base["dysonSwarm"]["totalLaunched"] = Value::from(52);
        let value = projection(&fixture_state_with(base), "helios", 0, 4);
        assert_eq!(value["selectedSystem"]["shellSails"], 15.0);
        assert_eq!(value["selectedSystem"]["totals"]["sailCapacity"], 10.0);
        assert_eq!(value["selectedSystem"]["totals"]["absorbedSails"], 15.0);
        assert_eq!(value["shells"]["rows"][0]["absorbedSails"], 5.0);
    }

    #[test]
    fn bounded_page_handles_the_maximum_directory_without_copying_unrequested_rows() {
        let rows = (0..MAX_TOTAL_ROWS)
            .map(|index| json!({ "id": index }))
            .collect::<Vec<_>>();
        let value = page(MAX_TOTAL_ROWS - 3, MAX_PAGE_ROWS, &rows, "test rows").unwrap();
        assert_eq!(value["totalCount"], MAX_TOTAL_ROWS);
        assert_eq!(value["rows"].as_array().unwrap().len(), 3);
        assert!(value["nextCursor"].is_null());
        assert!(page(MAX_TOTAL_ROWS + 1, 1, &rows, "test rows").is_err());
    }
}

fn non_negative_integer_or(
    value: Option<&Value>,
    fallback: f64,
    label: &str,
) -> anyhow::Result<f64> {
    match value {
        None | Some(Value::Null) => Ok(fallback),
        Some(_) => non_negative_integer(value, label),
    }
}

fn bounded_number(
    value: Option<&Value>,
    minimum: f64,
    maximum: f64,
    label: &str,
) -> anyhow::Result<f64> {
    let value = finite_number(value, label)?;
    if value < minimum || value > maximum {
        bail!("native Dyson workspace {label} is outside the supported range");
    }
    Ok(value)
}

fn checked_add(target: &mut f64, amount: f64, label: &str) -> anyhow::Result<()> {
    let next = *target + amount;
    if !next.is_finite() || !(0.0..=MAX_SAFE_INTEGER).contains(&next) {
        bail!("native Dyson workspace {label} overflowed");
    }
    *target = next;
    Ok(())
}

fn rounded(value: f64, digits: i32) -> f64 {
    let scale = 10_f64.powi(digits);
    (value * scale).round() / scale
}

fn completed_tech_ids(base: &Map<String, Value>) -> anyhow::Result<HashSet<&str>> {
    let values = object_at(base, "research")
        .and_then(|research| research.get("completedTechIds"))
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("native Dyson workspace completed technologies are missing"))?;
    let mut completed = HashSet::with_capacity(values.len());
    for value in values {
        let id = opaque_id(Some(value), "completed technology ID")?;
        if !completed.insert(id) {
            bail!("native Dyson workspace completed technologies contain a duplicate");
        }
    }
    Ok(completed)
}

fn infinite_level(base: &Map<String, Value>, research_id: &str) -> anyhow::Result<f64> {
    let value = object_at(base, "endgame")
        .and_then(|endgame| nested_object(Some(endgame), "infiniteResearch"))
        .and_then(|research| research.get(research_id))
        .and_then(Value::as_object)
        .and_then(|progress| progress.get("level"));
    non_negative_integer_or(value, 0.0, "infinite research level")
}

fn power_multiplier(base: &Map<String, Value>) -> anyhow::Result<f64> {
    Ok(1.0 + infinite_level(base, "stellar_harnessing")? * 0.05)
}

fn system_profile<'a>(
    base: &'a Map<String, Value>,
    system_id: &str,
) -> Option<&'a Map<String, Value>> {
    nested_object(object_at(base, "galaxy"), "systemProfiles")?
        .get(system_id)
        .and_then(Value::as_object)
}

fn system_luminosity(base: &Map<String, Value>, system_id: &str) -> anyhow::Result<f64> {
    let Some(profile) = system_profile(base, system_id) else {
        return Ok(1.0);
    };
    let luminosity = finite_number_or(profile.get("luminosity"), 1.0, "stellar luminosity")?;
    if luminosity <= 0.0 || luminosity > 1_000_000.0 {
        bail!("native Dyson workspace stellar luminosity is invalid");
    }
    Ok(luminosity)
}

fn custom_system_name<'a>(base: &'a Map<String, Value>, system_id: &str) -> Option<&'a str> {
    nested_object(object_at(base, "galaxy"), "systemMetadata")?
        .get(system_id)
        .and_then(Value::as_object)
        .and_then(|metadata| metadata.get("customName"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
}

fn system_ids(state: &CoreState, base: &Map<String, Value>) -> anyhow::Result<Vec<String>> {
    let mut ordered = Vec::<String>::new();
    let mut seen = HashSet::<String>::new();
    for planet in &state.catalog.planets {
        if !valid_opaque_id(&planet.system_id) {
            bail!("native Dyson workspace catalog system ID is invalid");
        }
        if seen.insert(planet.system_id.clone()) {
            ordered.push(planet.system_id.clone());
        }
    }
    let mut extras = BTreeSet::<String>::new();
    for directory in [
        object_at(base, "dysonPlans"),
        object_at(base, "dysonEngineering")
            .and_then(|engineering| nested_object(Some(engineering), "orbitsBySystem")),
    ]
    .into_iter()
    .flatten()
    {
        for id in directory.keys() {
            if !valid_opaque_id(id) {
                bail!("native Dyson workspace state system ID is invalid");
            }
            if !seen.contains(id) {
                extras.insert(id.clone());
            }
        }
    }
    if let Some(values) = object_at(base, "exploration")
        .and_then(|exploration| exploration.get("unlockedSystemIds"))
        .and_then(Value::as_array)
    {
        for value in values {
            let id = opaque_id(Some(value), "unlocked system ID")?;
            if !seen.contains(id) {
                extras.insert(id.to_owned());
            }
        }
    }
    ordered.extend(extras);
    if ordered.is_empty() || ordered.len() > MAX_TOTAL_ROWS {
        bail!("native Dyson workspace system directory is outside the row limit");
    }
    Ok(ordered)
}

fn active_system_id<'a>(
    state: &'a CoreState,
    base: &Map<String, Value>,
) -> anyhow::Result<&'a str> {
    let active_planet_id = opaque_id(base.get("activePlanetId"), "active planet ID")?;
    state
        .catalog
        .planets
        .iter()
        .find(|planet| planet.id == active_planet_id)
        .map(|planet| planet.system_id.as_str())
        .ok_or_else(|| anyhow!("native Dyson workspace active planet is absent from the catalog"))
}

fn unlocked_systems(base: &Map<String, Value>) -> anyhow::Result<HashSet<&str>> {
    let values = object_at(base, "exploration")
        .and_then(|exploration| exploration.get("unlockedSystemIds"))
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("native Dyson workspace unlocked systems are missing"))?;
    let mut result = HashSet::with_capacity(values.len());
    for value in values {
        let id = opaque_id(Some(value), "unlocked system ID")?;
        if !result.insert(id) {
            bail!("native Dyson workspace unlocked systems contain a duplicate");
        }
    }
    Ok(result)
}

fn page(cursor: usize, limit: usize, rows: &[Value], label: &str) -> anyhow::Result<Value> {
    if !(1..=MAX_PAGE_ROWS).contains(&limit) || cursor > u32::MAX as usize || cursor > rows.len() {
        bail!("native Dyson workspace {label} page is invalid");
    }
    let end = cursor.saturating_add(limit).min(rows.len());
    let page_rows = rows[cursor..end].to_vec();
    Ok(json!({
        "cursor": cursor,
        "limit": limit,
        "totalCount": rows.len(),
        "nextCursor": (end < rows.len()).then_some(end),
        "rows": page_rows,
    }))
}

fn validate_request(request: &Value) -> anyhow::Result<()> {
    if serde_json::to_vec(request)?.len() > MAX_REQUEST_BYTES {
        bail!("native Dyson workspace request exceeds the byte limit");
    }
    Ok(())
}

fn plan_for_system(base: &Map<String, Value>, system_id: &str) -> anyhow::Result<PlanRows> {
    let Some(plan_value) = object_at(base, "dysonPlans").and_then(|plans| plans.get(system_id))
    else {
        return Ok(PlanRows::default());
    };
    let plan = plan_value
        .as_object()
        .ok_or_else(|| anyhow!("native Dyson workspace plan is invalid"))?;
    let stored_system_id = opaque_id(plan.get("systemId"), "plan system ID")?;
    if stored_system_id != system_id {
        bail!("native Dyson workspace plan system identity is inconsistent");
    }
    let structure_points =
        non_negative_integer(plan.get("structurePoints"), "plan structure points")?;
    let shell_sails = non_negative_integer(plan.get("shellSails"), "plan shell sails")?;
    let source_layers = plan
        .get("layers")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("native Dyson workspace layers are invalid"))?;
    if source_layers.len() > MAX_TOTAL_ROWS {
        bail!("native Dyson workspace layers exceed the row limit");
    }

    let mut result = PlanRows {
        active_layer_id: optional_opaque_id(plan.get("activeLayerId"), "active layer ID")?,
        structure_points,
        shell_sails,
        layers: Vec::with_capacity(source_layers.len()),
        ..PlanRows::default()
    };
    let mut layer_ids = HashSet::with_capacity(source_layers.len());
    for (layer_index, layer_value) in source_layers.iter().enumerate() {
        let layer = layer_value
            .as_object()
            .ok_or_else(|| anyhow!("native Dyson workspace layer {layer_index} is invalid"))?;
        let layer_id = opaque_id(layer.get("id"), "layer ID")?;
        if !layer_ids.insert(layer_id) {
            bail!("native Dyson workspace repeats a layer ID");
        }
        let (name, name_truncated) =
            bounded_label(layer.get("name").and_then(Value::as_str), layer_id);
        let radius = bounded_number(layer.get("radius"), 5_000.0, 50_000.0, "layer radius")?;
        let inclination =
            bounded_number(layer.get("inclination"), -90.0, 90.0, "layer inclination")?;
        let longitude = bounded_number(layer.get("longitude"), 0.0, 360.0, "layer longitude")?;
        if longitude >= 360.0 {
            bail!("native Dyson workspace layer longitude is invalid");
        }
        let structure_allocation_floor = non_negative_integer_or(
            layer.get("structureAllocationFloor"),
            0.0,
            "layer structure allocation floor",
        )?;
        let shell_allocation_floor = non_negative_integer_or(
            layer.get("shellAllocationFloor"),
            0.0,
            "layer shell allocation floor",
        )?;
        let source_nodes = layer
            .get("nodes")
            .and_then(Value::as_array)
            .ok_or_else(|| anyhow!("native Dyson workspace layer nodes are invalid"))?;
        let source_frames = layer
            .get("frames")
            .and_then(Value::as_array)
            .ok_or_else(|| anyhow!("native Dyson workspace layer frames are invalid"))?;
        let source_shells = layer
            .get("shells")
            .and_then(Value::as_array)
            .ok_or_else(|| anyhow!("native Dyson workspace layer shells are invalid"))?;
        if result.nodes.len().saturating_add(source_nodes.len()) > MAX_TOTAL_ROWS
            || result.frames.len().saturating_add(source_frames.len()) > MAX_TOTAL_ROWS
            || result.shells.len().saturating_add(source_shells.len()) > MAX_TOTAL_ROWS
        {
            bail!("native Dyson workspace plan arrays exceed the row limit");
        }

        let mut node_ids = HashSet::with_capacity(source_nodes.len());
        let mut layer_planned = 0.0;
        let mut layer_completed = 0.0;
        for node_value in source_nodes {
            let node = node_value
                .as_object()
                .ok_or_else(|| anyhow!("native Dyson workspace node is invalid"))?;
            let node_id = opaque_id(node.get("id"), "node ID")?;
            if !node_ids.insert(node_id) {
                bail!("native Dyson workspace repeats a node ID");
            }
            let angle = bounded_number(node.get("angle"), 0.0, 360.0, "node angle")?;
            if angle >= 360.0 {
                bail!("native Dyson workspace node angle is invalid");
            }
            let required = non_negative_integer(
                node.get("requiredStructurePoints"),
                "node required structure points",
            )?;
            if required < 1.0 {
                bail!("native Dyson workspace node requirement is invalid");
            }
            let completed = non_negative_integer(
                node.get("completedStructurePoints"),
                "node completed structure points",
            )?;
            if completed > required {
                bail!("native Dyson workspace node completion exceeds its requirement");
            }
            checked_add(&mut layer_planned, required, "layer planned structure")?;
            checked_add(&mut layer_completed, completed, "layer completed structure")?;
            result.nodes.push(json!({
                "layerId": layer_id,
                "nodeId": node_id,
                "angle": angle,
                "requiredStructurePoints": required,
                "completedStructurePoints": completed,
            }));
        }

        let mut frame_ids = HashSet::with_capacity(source_frames.len());
        let mut completed_frame_ids = HashSet::with_capacity(source_frames.len());
        for frame_value in source_frames {
            let frame = frame_value
                .as_object()
                .ok_or_else(|| anyhow!("native Dyson workspace frame is invalid"))?;
            let frame_id = opaque_id(frame.get("id"), "frame ID")?;
            if !frame_ids.insert(frame_id) {
                bail!("native Dyson workspace repeats a frame ID");
            }
            let source_node_id = opaque_id(frame.get("sourceNodeId"), "frame source node ID")?;
            let target_node_id = opaque_id(frame.get("targetNodeId"), "frame target node ID")?;
            if source_node_id == target_node_id
                || !node_ids.contains(source_node_id)
                || !node_ids.contains(target_node_id)
            {
                bail!("native Dyson workspace frame node binding is invalid");
            }
            let required = non_negative_integer(
                frame.get("requiredStructurePoints"),
                "frame required structure points",
            )?;
            if required < 1.0 {
                bail!("native Dyson workspace frame requirement is invalid");
            }
            let completed = non_negative_integer(
                frame.get("completedStructurePoints"),
                "frame completed structure points",
            )?;
            if completed > required {
                bail!("native Dyson workspace frame completion exceeds its requirement");
            }
            if completed >= required {
                completed_frame_ids.insert(frame_id);
            }
            checked_add(&mut layer_planned, required, "layer planned structure")?;
            checked_add(&mut layer_completed, completed, "layer completed structure")?;
            result.frames.push(json!({
                "layerId": layer_id,
                "frameId": frame_id,
                "sourceNodeId": source_node_id,
                "targetNodeId": target_node_id,
                "requiredStructurePoints": required,
                "completedStructurePoints": completed,
            }));
        }

        let mut shell_ids = HashSet::with_capacity(source_shells.len());
        let mut layer_sail_capacity = 0.0;
        let mut layer_absorbed_sails = 0.0;
        for shell_value in source_shells {
            let shell = shell_value
                .as_object()
                .ok_or_else(|| anyhow!("native Dyson workspace shell is invalid"))?;
            let shell_id = opaque_id(shell.get("id"), "shell ID")?;
            if !shell_ids.insert(shell_id) {
                bail!("native Dyson workspace repeats a shell ID");
            }
            let source_node_id = opaque_id(shell.get("sourceNodeId"), "shell source node ID")?;
            let target_node_id = opaque_id(shell.get("targetNodeId"), "shell target node ID")?;
            if source_node_id == target_node_id
                || !node_ids.contains(source_node_id)
                || !node_ids.contains(target_node_id)
            {
                bail!("native Dyson workspace shell node binding is invalid");
            }
            let boundary_values = shell
                .get("boundaryFrameIds")
                .and_then(Value::as_array)
                .ok_or_else(|| anyhow!("native Dyson workspace shell boundary is invalid"))?;
            if boundary_values.is_empty() || boundary_values.len() > MAX_TOTAL_ROWS {
                bail!("native Dyson workspace shell boundary count is invalid");
            }
            let mut boundary_ids = HashSet::with_capacity(boundary_values.len());
            let mut active = true;
            for value in boundary_values {
                let boundary_id = opaque_id(Some(value), "shell boundary frame ID")?;
                if !boundary_ids.insert(boundary_id) || !frame_ids.contains(boundary_id) {
                    bail!("native Dyson workspace shell boundary binding is invalid");
                }
                active &= completed_frame_ids.contains(boundary_id);
            }
            let sail_capacity =
                non_negative_integer(shell.get("sailCapacity"), "shell sail capacity")?;
            if sail_capacity < 1.0 {
                bail!("native Dyson workspace shell capacity is invalid");
            }
            let absorbed_sails =
                non_negative_integer(shell.get("absorbedSails"), "shell absorbed sails")?;
            if absorbed_sails > sail_capacity {
                bail!("native Dyson workspace shell absorption exceeds capacity");
            }
            if active {
                checked_add(
                    &mut layer_sail_capacity,
                    sail_capacity,
                    "layer sail capacity",
                )?;
            }
            checked_add(
                &mut layer_absorbed_sails,
                absorbed_sails,
                "layer absorbed sails",
            )?;
            result.shells.push(json!({
                "layerId": layer_id,
                "shellId": shell_id,
                "sourceNodeId": source_node_id,
                "targetNodeId": target_node_id,
                "boundaryFrameCount": boundary_values.len(),
                "active": active,
                "sailCapacity": sail_capacity,
                "absorbedSails": absorbed_sails,
            }));
        }

        checked_add(
            &mut result.planned_structure,
            layer_planned,
            "planned structure",
        )?;
        checked_add(
            &mut result.completed_structure,
            layer_completed,
            "completed structure",
        )?;
        checked_add(
            &mut result.sail_capacity,
            layer_sail_capacity,
            "sail capacity",
        )?;
        checked_add(
            &mut result.absorbed_sails,
            layer_absorbed_sails,
            "absorbed sails",
        )?;
        result.layers.push(json!({
            "layerId": layer_id,
            "name": name,
            "nameTruncated": name_truncated,
            "radius": radius,
            "inclination": inclination,
            "longitude": longitude,
            "structureAllocationFloor": structure_allocation_floor,
            "shellAllocationFloor": shell_allocation_floor,
            "nodeCount": source_nodes.len(),
            "frameCount": source_frames.len(),
            "shellCount": source_shells.len(),
            "plannedStructurePoints": layer_planned,
            "completedStructurePoints": layer_completed,
            "sailCapacity": layer_sail_capacity,
            "absorbedSails": layer_absorbed_sails,
        }));
    }
    if let Some(active_layer_id) = result.active_layer_id.as_deref()
        && !layer_ids.contains(active_layer_id)
    {
        bail!("native Dyson workspace active layer is absent from its plan");
    }
    if result.layers.is_empty() {
        result.sail_capacity = result.structure_points * DYSON_SHELL_CAPACITY_PER_STRUCTURE;
    }
    // `plan.shellSails` is the authoritative historical absorbed total. Plan
    // edits may temporarily leave fewer active shell cells than that total;
    // the existing v47 renderer deliberately continues to show and power the
    // absorbed sails instead of destroying them. Per-shell rows still expose
    // their current reconciled allocations, while the plan total remains the
    // authoritative player-visible aggregate.
    result.absorbed_sails = result.shell_sails;
    Ok(result)
}

fn orbits_for_system(
    base: &Map<String, Value>,
    system_id: &str,
    power_multiplier: f64,
    luminosity: f64,
) -> anyhow::Result<OrbitRows> {
    let engineering = object_at(base, "dysonEngineering")
        .ok_or_else(|| anyhow!("native Dyson workspace engineering state is missing"))?;
    let active_orbit_id = nested_object(Some(engineering), "activeOrbitBySystem")
        .and_then(|active| active.get(system_id));
    let mut result = OrbitRows {
        active_orbit_id: optional_opaque_id(active_orbit_id, "active orbit ID")?,
        ..OrbitRows::default()
    };
    let Some(orbits_value) = nested_object(Some(engineering), "orbitsBySystem")
        .and_then(|systems| systems.get(system_id))
    else {
        if result.active_orbit_id.is_some() {
            bail!("native Dyson workspace active orbit has no orbit directory");
        }
        return Ok(result);
    };
    let orbits = orbits_value
        .as_array()
        .ok_or_else(|| anyhow!("native Dyson workspace orbit directory is invalid"))?;
    if orbits.len() > MAX_TOTAL_ROWS {
        bail!("native Dyson workspace orbits exceed the row limit");
    }
    let per_sail_kw = SOLAR_SAIL_POWER_KW * power_multiplier * luminosity;
    let mut ids = HashSet::with_capacity(orbits.len());
    for orbit_value in orbits {
        let orbit = orbit_value
            .as_object()
            .ok_or_else(|| anyhow!("native Dyson workspace orbit is invalid"))?;
        let orbit_id = opaque_id(orbit.get("id"), "orbit ID")?;
        if !ids.insert(orbit_id) {
            bail!("native Dyson workspace repeats an orbit ID");
        }
        let (name, name_truncated) =
            bounded_label(orbit.get("name").and_then(Value::as_str), orbit_id);
        let radius = bounded_number(orbit.get("radius"), 5_000.0, 50_000.0, "orbit radius")?;
        let inclination =
            bounded_number(orbit.get("inclination"), -90.0, 90.0, "orbit inclination")?;
        let longitude = bounded_number(orbit.get("longitude"), 0.0, 360.0, "orbit longitude")?;
        if longitude >= 360.0 {
            bail!("native Dyson workspace orbit longitude is invalid");
        }
        let sails_in_orbit = non_negative_integer(orbit.get("sailsInOrbit"), "orbit sails")?;
        let total_launched =
            non_negative_integer(orbit.get("totalLaunched"), "orbit total launched")?;
        let total_expired = non_negative_integer(orbit.get("totalExpired"), "orbit total expired")?;
        let decay_progress =
            non_negative_number(orbit.get("decayProgress"), "orbit decay progress")?;
        if !(0.0..1.0 + EPSILON).contains(&decay_progress)
            || total_launched + EPSILON < sails_in_orbit + total_expired
        {
            bail!("native Dyson workspace orbit counters are inconsistent");
        }
        let generation_kw = sails_in_orbit * per_sail_kw;
        checked_add(
            &mut result.sails_in_orbit,
            sails_in_orbit,
            "system orbit sails",
        )?;
        checked_add(
            &mut result.total_launched,
            total_launched,
            "system sails launched",
        )?;
        checked_add(
            &mut result.total_expired,
            total_expired,
            "system sails expired",
        )?;
        checked_add(
            &mut result.generation_kw,
            generation_kw,
            "system swarm generation",
        )?;
        result.rows.push(json!({
            "orbitId": orbit_id,
            "name": name,
            "nameTruncated": name_truncated,
            "radius": radius,
            "inclination": inclination,
            "longitude": longitude,
            "sailsInOrbit": sails_in_orbit,
            "totalLaunched": total_launched,
            "totalExpired": total_expired,
            "decayProgress": decay_progress,
            "generationKw": generation_kw,
        }));
    }
    if let Some(active_orbit_id) = result.active_orbit_id.as_deref()
        && !ids.contains(active_orbit_id)
    {
        bail!("native Dyson workspace active orbit is absent from its system");
    }
    Ok(result)
}

fn entity_indices_for_system(state: &CoreState, system_id: &str) -> Vec<usize> {
    let mut indices = Vec::new();
    for (planet_index, planet) in state.catalog.planets.iter().enumerate() {
        if planet.system_id != system_id {
            continue;
        }
        if let Some(rows) = state.factory_topology.entities_by_planet.get(planet_index) {
            indices.extend(rows.iter().map(|row| *row as usize));
        }
    }
    indices.sort_unstable();
    indices.dedup();
    indices
}

fn object_number(object: &Map<String, Value>, key: &str) -> f64 {
    object
        .get(key)
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .unwrap_or(0.0)
}

fn completed(completed_tech_ids: &HashSet<&str>, id: &str) -> bool {
    completed_tech_ids.contains(id)
}

fn receiver_capacity_kw(completed_tech_ids: &HashSet<&str>, power_multiplier: f64) -> f64 {
    RAY_RECEIVER_CAPACITY_KW
        * (1.0
            + if completed(completed_tech_ids, "ray_transmission_1") {
                0.5
            } else {
                0.0
            }
            + if completed(completed_tech_ids, "ray_transmission_2") {
                0.5
            } else {
                0.0
            })
        * power_multiplier
}

fn receiver_runnable(
    state: &CoreState,
    base: &Map<String, Value>,
    completed_tech_ids: &HashSet<&str>,
    entity: &Map<String, Value>,
) -> anyhow::Result<bool> {
    let Some(recipe_id) = entity.get("recipeId").and_then(Value::as_str) else {
        return Ok(false);
    };
    let Some(recipe) = state.catalog.recipes.get(recipe_id) else {
        return Ok(false);
    };
    if recipe
        .required_tech_id
        .as_deref()
        .is_some_and(|id| !completed(completed_tech_ids, id))
    {
        return Ok(false);
    }
    if recipe_id == "ray_power" {
        return Ok(true);
    }
    if recipe_id != "critical_photon" {
        return Ok(false);
    }
    let current = entity
        .get("outputs")
        .and_then(Value::as_object)
        .and_then(|outputs| outputs.get("critical_photon"))
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .unwrap_or(0.0)
        .max(0.0);
    let buffer_limit = object_at(base, "settings")
        .and_then(|settings| settings.get("productionBufferLimit"))
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .map(|value| value.floor().clamp(1_000.0, 100_000_000.0))
        .unwrap_or(1_000_000.0);
    let machine_count = object_number(entity, "machineCount").floor().max(1.0);
    let output_capacity = if state
        .catalog
        .buildings
        .get("ray_receiver")
        .is_some_and(|building| building.output_capacity > 0.0)
    {
        (state.catalog.buildings["ray_receiver"]
            .output_capacity
            .floor()
            * machine_count)
            .min(buffer_limit)
    } else {
        0.0
    };
    Ok(output_capacity - current + EPSILON >= 1.0)
}

#[allow(clippy::too_many_arguments)]
fn engineering_summary(
    state: &CoreState,
    base: &Map<String, Value>,
    completed_tech_ids: &HashSet<&str>,
    system_id: &str,
    orbit_rows: &OrbitRows,
    plan: &PlanRows,
    power_multiplier: f64,
    luminosity: f64,
) -> anyhow::Result<Value> {
    let engineering = object_at(base, "dysonEngineering")
        .ok_or_else(|| anyhow!("native Dyson workspace engineering state is missing"))?;
    let launch_mode = engineering
        .get("launchMode")
        .and_then(Value::as_str)
        .filter(|value| matches!(*value, "balanced" | "swarm" | "sphere"))
        .ok_or_else(|| anyhow!("native Dyson workspace launch mode is invalid"))?;
    let launch_throttle = finite_number(engineering.get("launchThrottle"), "launch throttle")?;
    if ![0.25, 0.5, 0.75, 1.0]
        .iter()
        .any(|candidate| (launch_throttle - candidate).abs() <= f64::EPSILON)
    {
        bail!("native Dyson workspace launch throttle is invalid");
    }
    let launch_enabled = engineering
        .get("launchEnabled")
        .and_then(Value::as_bool)
        .ok_or_else(|| anyhow!("native Dyson workspace launch enabled state is invalid"))?;
    let launch_factor = |recipe_id: &str| {
        if !launch_enabled
            || launch_mode == "swarm" && recipe_id == "carrier_rocket_launch"
            || launch_mode == "sphere" && recipe_id == "solar_sail_launch"
        {
            0.0
        } else {
            launch_throttle
        }
    };
    let mut queued_sails = 0.0;
    let mut queued_rockets = 0.0;
    let mut sail_launches_per_minute = 0.0;
    let mut rocket_launches_per_minute = 0.0;
    let mut ray_generation_kw = 0.0;
    let mut receiver_capacity_kw_total = 0.0;
    let mut operational_receiver_capacity_kw = 0.0;
    let mut receiver_load_kw = 0.0;
    let mut configured_receiver_count = 0.0;
    let mut blocked_receiver_count = 0.0;
    let mut critical_photon_per_minute = 0.0;
    let mut antimatter_per_minute = 0.0;
    let mut feedback_generation_kw = 0.0;
    let rated_receiver_capacity_kw = receiver_capacity_kw(completed_tech_ids, power_multiplier);

    for entity_index in entity_indices_for_system(state, system_id) {
        let entity = state.parse_entity(entity_index)?;
        let entity = entity
            .as_object()
            .ok_or_else(|| anyhow!("native Dyson workspace entity is invalid"))?;
        let kind = entity.get("kind").and_then(Value::as_str);
        let building_id = entity.get("buildingId").and_then(Value::as_str);
        let recipe_id = entity.get("recipeId").and_then(Value::as_str);
        let machine_count = object_number(entity, "machineCount").floor().max(0.0);
        if kind == Some("machine")
            && matches!(
                recipe_id,
                Some("solar_sail_launch" | "carrier_rocket_launch")
            )
            && let (Some(building_id), Some(recipe_id)) = (building_id, recipe_id)
            && let (Some(building), Some(recipe)) = (
                state.catalog.buildings.get(building_id),
                state.catalog.recipes.get(recipe_id),
            )
        {
            let input_item = if recipe_id == "solar_sail_launch" {
                "solar_sail"
            } else {
                "small_carrier_rocket"
            };
            let queued = entity
                .get("inputs")
                .and_then(Value::as_object)
                .and_then(|inputs| inputs.get(input_item))
                .and_then(Value::as_f64)
                .filter(|value| value.is_finite())
                .unwrap_or(0.0)
                .floor()
                .max(0.0);
            let target_valid = recipe_id != "solar_sail_launch"
                || crate::dyson::valid_ejector_target(state, base, entity);
            let rate = if target_valid && recipe.duration > 0.0 {
                building.speed * machine_count / recipe.duration * 60.0 * launch_factor(recipe_id)
            } else {
                0.0
            };
            if recipe_id == "solar_sail_launch" {
                checked_add(&mut queued_sails, queued, "queued sails")?;
                checked_add(&mut sail_launches_per_minute, rate, "sail launch rate")?;
            } else {
                checked_add(&mut queued_rockets, queued, "queued rockets")?;
                checked_add(&mut rocket_launches_per_minute, rate, "rocket launch rate")?;
            }
        }
        if recipe_id == Some("critical_photon") {
            checked_add(
                &mut critical_photon_per_minute,
                object_number(entity, "productionRate").max(0.0),
                "critical photon rate",
            )?;
        }
        if recipe_id == Some("antimatter") {
            checked_add(
                &mut antimatter_per_minute,
                object_number(entity, "productionRate").max(0.0) * 0.5,
                "antimatter rate",
            )?;
        }
        if building_id == Some("artificial_star") {
            checked_add(
                &mut feedback_generation_kw,
                object_number(entity, "powerOutputKw").max(0.0),
                "antimatter feedback generation",
            )?;
        }
        if building_id == Some("ray_receiver")
            && matches!(recipe_id, Some("ray_power" | "critical_photon"))
        {
            checked_add(
                &mut configured_receiver_count,
                machine_count,
                "configured receiver count",
            )?;
            checked_add(
                &mut receiver_capacity_kw_total,
                rated_receiver_capacity_kw * machine_count,
                "receiver capacity",
            )?;
            let runnable = kind == Some("machine")
                && machine_count > 0.0
                && receiver_runnable(state, base, completed_tech_ids, entity)?;
            if runnable {
                checked_add(
                    &mut operational_receiver_capacity_kw,
                    rated_receiver_capacity_kw * machine_count,
                    "operational receiver capacity",
                )?;
            } else {
                checked_add(
                    &mut blocked_receiver_count,
                    machine_count,
                    "blocked receiver count",
                )?;
            }
            let output = object_number(entity, "powerOutputKw").max(0.0);
            checked_add(&mut receiver_load_kw, output, "receiver load")?;
            if recipe_id == Some("ray_power") {
                checked_add(&mut ray_generation_kw, output, "ray generation")?;
            }
        }
    }

    let projected_generation_kw = orbit_rows.generation_kw
        + (plan.structure_points * DYSON_STRUCTURE_POWER_KW
            + plan.shell_sails * DYSON_SHELL_SAIL_POWER_KW)
            * power_multiplier
            * luminosity;
    let theoretical_reception_rate = if receiver_capacity_kw_total > EPSILON {
        (projected_generation_kw / receiver_capacity_kw_total).min(1.0)
    } else {
        0.0
    };
    let receiver_utilization = if operational_receiver_capacity_kw > EPSILON {
        (receiver_load_kw / operational_receiver_capacity_kw).min(1.0)
    } else {
        0.0
    };
    let dyson_power_utilization = if projected_generation_kw > EPSILON {
        (receiver_load_kw / projected_generation_kw).min(1.0)
    } else {
        0.0
    };
    let sail_launches_per_minute = rounded(sail_launches_per_minute, 2);
    let rocket_launches_per_minute = rounded(rocket_launches_per_minute, 2);
    Ok(json!({
        "launchMode": launch_mode,
        "launchThrottle": launch_throttle,
        "launchEnabled": launch_enabled,
        "orbitCount": orbit_rows.rows.len(),
        "orbitSails": orbit_rows.sails_in_orbit,
        "queuedSails": queued_sails,
        "queuedRockets": queued_rockets,
        "sailLaunchesPerMinute": sail_launches_per_minute,
        "rocketLaunchesPerMinute": rocket_launches_per_minute,
        "launchEnergyPerSailMj": DYSON_SAIL_LAUNCH_ENERGY_MJ,
        "launchEnergyPerRocketMj": DYSON_ROCKET_LAUNCH_ENERGY_MJ,
        "launchEnergyPerMinuteMj": rounded(
            sail_launches_per_minute * DYSON_SAIL_LAUNCH_ENERGY_MJ
                + rocket_launches_per_minute * DYSON_ROCKET_LAUNCH_ENERGY_MJ,
            2,
        ),
        "rayGenerationKw": ray_generation_kw,
        "receiverCapacityKw": receiver_capacity_kw_total,
        "operationalReceiverCapacityKw": operational_receiver_capacity_kw,
        "receiverLoadKw": receiver_load_kw,
        "theoreticalReceptionRate": rounded(theoretical_reception_rate, 4),
        "receiverUtilization": rounded(receiver_utilization, 4),
        "dysonPowerUtilization": rounded(dyson_power_utilization, 4),
        "configuredReceiverCount": configured_receiver_count,
        "blockedReceiverCount": blocked_receiver_count,
        "criticalPhotonPerMinute": rounded(critical_photon_per_minute, 2),
        "antimatterPerMinute": rounded(antimatter_per_minute, 2),
        "feedbackGenerationKw": rounded(feedback_generation_kw, 2),
        "plannedStructurePoints": plan.planned_structure,
        "completedStructurePoints": plan.completed_structure,
        "remainingStructurePoints": (plan.planned_structure - plan.completed_structure).max(0.0),
        "shellCapacity": plan.sail_capacity,
        "shellSails": plan.shell_sails,
        "projectedGenerationKw": projected_generation_kw.floor(),
    }))
}

#[allow(clippy::too_many_arguments)]
impl CoreState {
    pub fn dyson_workspace_projection(
        &self,
        expected_revision: u64,
        expected_registry_fingerprint: &str,
        selected_system_id: &str,
        system_cursor: usize,
        system_limit: usize,
        layer_cursor: usize,
        layer_limit: usize,
        orbit_cursor: usize,
        orbit_limit: usize,
        node_cursor: usize,
        node_limit: usize,
        frame_cursor: usize,
        frame_limit: usize,
        shell_cursor: usize,
        shell_limit: usize,
    ) -> anyhow::Result<Value> {
        if expected_revision != self.revision
            || expected_registry_fingerprint != self.catalog.snapshot.registry_fingerprint
        {
            bail!("native Dyson workspace projection identity is stale");
        }
        if !valid_opaque_id(selected_system_id) {
            bail!("native Dyson workspace selected system ID is invalid");
        }
        for (cursor, limit, label) in [
            (system_cursor, system_limit, "systems"),
            (layer_cursor, layer_limit, "layers"),
            (orbit_cursor, orbit_limit, "orbits"),
            (node_cursor, node_limit, "nodes"),
            (frame_cursor, frame_limit, "frames"),
            (shell_cursor, shell_limit, "shells"),
        ] {
            if cursor > u32::MAX as usize || !(1..=MAX_PAGE_ROWS).contains(&limit) {
                bail!("native Dyson workspace {label} page request is invalid");
            }
        }
        let request = json!({
            "expectedRevision": expected_revision,
            "expectedRegistryFingerprint": expected_registry_fingerprint,
            "selectedSystemId": selected_system_id,
            "systemCursor": system_cursor,
            "systemLimit": system_limit,
            "layerCursor": layer_cursor,
            "layerLimit": layer_limit,
            "orbitCursor": orbit_cursor,
            "orbitLimit": orbit_limit,
            "nodeCursor": node_cursor,
            "nodeLimit": node_limit,
            "frameCursor": frame_cursor,
            "frameLimit": frame_limit,
            "shellCursor": shell_cursor,
            "shellLimit": shell_limit,
        });
        validate_request(&request)?;

        let base = self.base_value();
        let systems = system_ids(self, base)?;
        if !systems
            .iter()
            .any(|system_id| system_id == selected_system_id)
        {
            bail!("native Dyson workspace selected system is unavailable");
        }
        let active_planet_id = opaque_id(base.get("activePlanetId"), "active planet ID")?;
        let active_system_id = active_system_id(self, base)?;
        let unlocked = unlocked_systems(base)?;
        let completed_tech_ids = completed_tech_ids(base)?;
        let power_multiplier = power_multiplier(base)?;
        let mut plan_by_system = HashMap::<String, PlanRows>::with_capacity(systems.len());
        let mut orbit_by_system = HashMap::<String, OrbitRows>::with_capacity(systems.len());
        let mut system_rows = Vec::with_capacity(systems.len());
        let mut total_layers = 0usize;
        let mut total_orbits = 0usize;
        let mut total_nodes = 0usize;
        let mut total_frames = 0usize;
        let mut total_shells = 0usize;
        let mut total_structure = 0.0;
        let mut total_shell_sails = 0.0;
        let mut total_orbit_sails = 0.0;
        let mut total_sails_launched = 0.0;
        let mut total_sails_expired = 0.0;
        let mut total_swarm_generation_kw = 0.0;
        let mut total_sphere_generation_kw = 0.0;

        for system_id in &systems {
            let luminosity = system_luminosity(base, system_id)?;
            let profile = system_profile(base, system_id);
            let (display_name, display_name_truncated) =
                bounded_label(custom_system_name(base, system_id), system_id);
            let (star_type_name, star_type_name_truncated) = bounded_label(
                profile
                    .and_then(|profile| profile.get("starTypeName"))
                    .and_then(Value::as_str),
                system_id,
            );
            let radius_multiplier = profile
                .map(|profile| {
                    finite_number_or(
                        profile.get("radiusMultiplier"),
                        1.0,
                        "stellar radius multiplier",
                    )
                })
                .transpose()?
                .unwrap_or(1.0);
            if radius_multiplier <= 0.0 || radius_multiplier > 1_000_000.0 {
                bail!("native Dyson workspace stellar radius multiplier is invalid");
            }
            let plan = plan_for_system(base, system_id)?;
            let orbits = orbits_for_system(base, system_id, power_multiplier, luminosity)?;
            let engineering = engineering_summary(
                self,
                base,
                &completed_tech_ids,
                system_id,
                &orbits,
                &plan,
                power_multiplier,
                luminosity,
            )?;
            let sphere_generation_kw = (plan.structure_points * DYSON_STRUCTURE_POWER_KW
                + plan.shell_sails * DYSON_SHELL_SAIL_POWER_KW)
                * power_multiplier
                * luminosity;
            total_layers = total_layers
                .checked_add(plan.layers.len())
                .ok_or_else(|| anyhow!("native Dyson workspace layer count overflowed"))?;
            total_orbits = total_orbits
                .checked_add(orbits.rows.len())
                .ok_or_else(|| anyhow!("native Dyson workspace orbit count overflowed"))?;
            total_nodes = total_nodes
                .checked_add(plan.nodes.len())
                .ok_or_else(|| anyhow!("native Dyson workspace node count overflowed"))?;
            total_frames = total_frames
                .checked_add(plan.frames.len())
                .ok_or_else(|| anyhow!("native Dyson workspace frame count overflowed"))?;
            total_shells = total_shells
                .checked_add(plan.shells.len())
                .ok_or_else(|| anyhow!("native Dyson workspace shell count overflowed"))?;
            checked_add(
                &mut total_structure,
                plan.structure_points,
                "global structure points",
            )?;
            checked_add(
                &mut total_shell_sails,
                plan.shell_sails,
                "global shell sails",
            )?;
            checked_add(
                &mut total_orbit_sails,
                orbits.sails_in_orbit,
                "global orbit sails",
            )?;
            checked_add(
                &mut total_sails_launched,
                orbits.total_launched,
                "global sails launched",
            )?;
            checked_add(
                &mut total_sails_expired,
                orbits.total_expired,
                "global sails expired",
            )?;
            checked_add(
                &mut total_swarm_generation_kw,
                orbits.generation_kw,
                "global swarm generation",
            )?;
            checked_add(
                &mut total_sphere_generation_kw,
                sphere_generation_kw,
                "global sphere generation",
            )?;
            system_rows.push(json!({
                "systemId": system_id,
                "displayName": display_name,
                "displayNameTruncated": display_name_truncated,
                "starProfile": {
                    "available": profile.is_some(),
                    "starTypeName": star_type_name,
                    "starTypeNameTruncated": star_type_name_truncated,
                    "luminosity": luminosity,
                    "radiusMultiplier": radius_multiplier,
                },
                "unlocked": unlocked.contains(system_id.as_str()),
                "active": system_id == active_system_id,
                "activeLayerId": plan.active_layer_id,
                "activeOrbitId": orbits.active_orbit_id,
                "structurePoints": plan.structure_points,
                "shellSails": plan.shell_sails,
                "totals": {
                    "layerCount": plan.layers.len(),
                    "nodeCount": plan.nodes.len(),
                    "frameCount": plan.frames.len(),
                    "shellCount": plan.shells.len(),
                    "plannedStructurePoints": plan.planned_structure,
                    "completedStructurePoints": plan.completed_structure,
                    "sailCapacity": plan.sail_capacity,
                    "absorbedSails": plan.absorbed_sails,
                },
                "orbitCount": orbits.rows.len(),
                "orbitSails": orbits.sails_in_orbit,
                "projectedGenerationKw": engineering["projectedGenerationKw"],
                "engineering": engineering,
            }));
            plan_by_system.insert(system_id.clone(), plan);
            orbit_by_system.insert(system_id.clone(), orbits);
        }
        if [
            total_layers,
            total_orbits,
            total_nodes,
            total_frames,
            total_shells,
        ]
        .into_iter()
        .any(|count| count > MAX_TOTAL_ROWS)
        {
            bail!("native Dyson workspace aggregate rows exceed the row limit");
        }

        let sphere = object_at(base, "dysonSphere")
            .ok_or_else(|| anyhow!("native Dyson workspace sphere state is missing"))?;
        let total_rockets_launched = non_negative_integer(
            sphere.get("totalRocketsLaunched"),
            "global rockets launched",
        )?;
        let total_sails_absorbed =
            non_negative_integer(sphere.get("totalSailsAbsorbed"), "global sails absorbed")?;
        let sphere_structure =
            non_negative_integer(sphere.get("structurePoints"), "sphere structure points")?;
        let sphere_shell_sails =
            non_negative_integer(sphere.get("shellSails"), "sphere shell sails")?;
        if sphere_structure != total_structure
            || sphere_shell_sails != total_shell_sails
            || total_rockets_launched < sphere_structure
            || total_sails_absorbed < sphere_shell_sails
        {
            bail!("native Dyson workspace sphere counters are inconsistent");
        }
        let swarm = object_at(base, "dysonSwarm")
            .ok_or_else(|| anyhow!("native Dyson workspace swarm state is missing"))?;
        let swarm_sails = non_negative_integer(swarm.get("sailsInOrbit"), "global swarm sails")?;
        let swarm_launched =
            non_negative_integer(swarm.get("totalLaunched"), "global sails launched")?;
        let swarm_expired =
            non_negative_integer(swarm.get("totalExpired"), "global sails expired")?;
        let receiver_load_kw =
            non_negative_number(swarm.get("receiverLoadKw"), "global receiver load")?;
        if swarm_sails != total_orbit_sails
            || swarm_launched != total_sails_launched
            || swarm_expired != total_sails_expired
            || swarm_launched + EPSILON < swarm_sails + swarm_expired + total_sails_absorbed
        {
            bail!("native Dyson workspace swarm counters are inconsistent");
        }
        let engineering = object_at(base, "dysonEngineering")
            .ok_or_else(|| anyhow!("native Dyson workspace engineering state is missing"))?;
        let launch_energy_spent_mj = non_negative_number(
            engineering.get("launchEnergySpentMj"),
            "launch energy spent",
        )?;
        let launch_mode = engineering
            .get("launchMode")
            .and_then(Value::as_str)
            .filter(|mode| matches!(*mode, "balanced" | "swarm" | "sphere"))
            .ok_or_else(|| anyhow!("native Dyson workspace launch mode is invalid"))?;
        let launch_throttle = finite_number(engineering.get("launchThrottle"), "launch throttle")?;
        let launch_enabled = engineering
            .get("launchEnabled")
            .and_then(Value::as_bool)
            .ok_or_else(|| anyhow!("native Dyson workspace launch enabled state is invalid"))?;

        let selected_index = systems
            .iter()
            .position(|system_id| system_id == selected_system_id)
            .expect("selected Dyson system was validated");
        let selected_plan = plan_by_system
            .get(selected_system_id)
            .expect("selected Dyson plan was projected");
        let selected_orbits = orbit_by_system
            .get(selected_system_id)
            .expect("selected Dyson orbits were projected");
        let projection = json!({
            "schemaVersion": 1,
            "projectionType": DYSON_WORKSPACE_SCHEMA,
            "revision": self.revision,
            "registryFingerprint": self.catalog.snapshot.registry_fingerprint,
            "stateVersion": 47,
            "limits": {
                "requestBytes": MAX_REQUEST_BYTES,
                "projectionBytes": MAX_PROJECTION_BYTES,
                "pageRows": MAX_PAGE_ROWS,
                "totalRows": MAX_TOTAL_ROWS,
                "idBytes": MAX_ID_BYTES,
                "labelBytes": MAX_LABEL_BYTES,
            },
            "request": request,
            "activePlanetId": active_planet_id,
            "activeSystemId": active_system_id,
            "selectedSystemId": selected_system_id,
            "technology": {
                "programReady": completed(&completed_tech_ids, "dyson_sphere_program"),
                "shellReady": completed(&completed_tech_ids, "dyson_shell"),
                "swarmReady": completed(&completed_tech_ids, "dyson_swarm"),
            },
            "global": {
                "sphere": {
                    "structurePoints": total_structure,
                    "totalRocketsLaunched": total_rockets_launched,
                    "shellSails": total_shell_sails,
                    "totalSailsAbsorbed": total_sails_absorbed,
                    "generationKw": total_sphere_generation_kw.floor(),
                },
                "swarm": {
                    "sailsInOrbit": total_orbit_sails,
                    "totalLaunched": total_sails_launched,
                    "totalExpired": total_sails_expired,
                    "generationKw": total_swarm_generation_kw,
                    "receiverLoadKw": receiver_load_kw,
                },
                "launch": {
                    "mode": launch_mode,
                    "throttle": launch_throttle,
                    "enabled": launch_enabled,
                    "energySpentMj": launch_energy_spent_mj,
                },
            },
            "summary": {
                "systemCount": systems.len(),
                "unlockedSystemCount": systems.iter().filter(|id| unlocked.contains(id.as_str())).count(),
                "layerCount": total_layers,
                "orbitCount": total_orbits,
                "nodeCount": total_nodes,
                "frameCount": total_frames,
                "shellCount": total_shells,
            },
            "selectedSystem": system_rows[selected_index].clone(),
            "systems": page(system_cursor, system_limit, &system_rows, "systems")?,
            "layers": page(layer_cursor, layer_limit, &selected_plan.layers, "layers")?,
            "orbits": page(orbit_cursor, orbit_limit, &selected_orbits.rows, "orbits")?,
            "nodes": page(node_cursor, node_limit, &selected_plan.nodes, "nodes")?,
            "frames": page(frame_cursor, frame_limit, &selected_plan.frames, "frames")?,
            "shells": page(shell_cursor, shell_limit, &selected_plan.shells, "shells")?,
        });
        if serde_json::to_vec(&projection)?.len() > MAX_PROJECTION_BYTES {
            bail!("native Dyson workspace projection exceeds the byte limit");
        }
        Ok(projection)
    }
}
