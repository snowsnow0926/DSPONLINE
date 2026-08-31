use anyhow::{anyhow, bail};
use serde_json::{Map, Value};
use std::collections::HashSet;

use crate::campaign::{workspace_completed_task_count, workspace_task_count};
use crate::state::CoreState;

const GALAXY_ACCOUNT_WORKSPACE_PROJECTION: &str = "galaxy-account-workspace-v1";
const MAX_GALAXY_ACCOUNT_WORKSPACE_BYTES: usize = 64 * 1024;
const MAX_DECIMAL_DIGITS: usize = 256;
const GAME_STATE_VERSION: u64 = 47;
const ENVELOPE_VERSION: u64 = 2;
const CLOUD_SCHEMA_VERSION: u64 = 8;
const MAX_JS_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

fn non_negative(value: Option<&Value>) -> f64 {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value > 0.0)
        .map(f64::floor)
        .unwrap_or(0.0)
}

fn record_total(record: Option<&Map<String, Value>>) -> f64 {
    record
        .into_iter()
        .flat_map(Map::values)
        .fold(0.0, |total, value| {
            let amount = non_negative(Some(value));
            saturating_float_add(total, amount)
        })
}

fn saturating_float_add(left: f64, right: f64) -> f64 {
    let left = if left.is_finite() && left > 0.0 {
        left
    } else {
        0.0
    };
    let right = if right.is_finite() && right > 0.0 {
        right
    } else {
        0.0
    };
    if left >= f64::MAX - right {
        f64::MAX
    } else {
        left + right
    }
}

fn decimal_256(value: f64) -> String {
    if !value.is_finite() || value <= 0.0 {
        return "0".to_owned();
    }
    if value >= 1e256 {
        return "9".repeat(MAX_DECIMAL_DIGITS);
    }
    let text = format!("{:.0}", value.floor());
    if text.len() > MAX_DECIMAL_DIGITS {
        "9".repeat(MAX_DECIMAL_DIGITS)
    } else {
        text
    }
}

fn object<'a>(base: &'a Map<String, Value>, key: &str) -> Option<&'a Map<String, Value>> {
    base.get(key).and_then(Value::as_object)
}

fn safe_count(value: usize) -> u64 {
    u64::try_from(value)
        .unwrap_or(u64::MAX)
        .min(MAX_JS_SAFE_INTEGER)
}

fn unique_known_array_count(
    base: &Map<String, Value>,
    object_key: &str,
    array_key: &str,
    known: impl Fn(&str) -> bool,
) -> u64 {
    let mut seen = HashSet::new();
    let count = object(base, object_key)
        .and_then(|record| record.get(array_key))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|id| known(id) && seen.insert((*id).to_owned()))
        .count();
    safe_count(count)
}

impl CoreState {
    /// Bounded game-only summary consumed beside, never merged into, the
    /// renderer-owned local account domain.
    pub fn galaxy_account_workspace_projection(
        &self,
        session_id: &str,
        run_id: &str,
        expected_revision: u64,
        expected_registry_fingerprint: &str,
    ) -> anyhow::Result<Value> {
        if expected_revision != self.revision {
            bail!("native galaxy account workspace revision is stale");
        }
        if expected_registry_fingerprint != self.identity.registry_fingerprint {
            bail!("native galaxy account workspace registry is stale");
        }
        if session_id.is_empty()
            || session_id.len() > 128
            || run_id.is_empty()
            || run_id.len() > 128
        {
            bail!("native galaxy account workspace lineage is invalid");
        }
        let base = self.base_value();
        let mode = base
            .get("mode")
            .and_then(Value::as_str)
            .filter(|mode| matches!(*mode, "normal" | "speedrun"))
            .ok_or_else(|| anyhow!("native galaxy account workspace mode is invalid"))?;
        let state_version = non_negative(base.get("version")) as u64;
        if state_version != GAME_STATE_VERSION {
            bail!("native galaxy account workspace state version is unsupported");
        }
        let settings = object(base, "settings");
        let difficulty = settings
            .and_then(|settings| settings.get("difficulty"))
            .and_then(Value::as_str)
            .filter(|difficulty| matches!(*difficulty, "relaxed" | "standard" | "hard"))
            .unwrap_or("standard");
        let produced = object(base, "totalProduced");
        let total_produced = record_total(produced);
        let universe_matrix = produced
            .map(|record| non_negative(record.get("universe_matrix")))
            .unwrap_or(0.0);

        let planet_metrics = object(base, "planetMetrics");
        let (generation_kw, throughput_per_minute) = planet_metrics
            .into_iter()
            .flat_map(Map::values)
            .filter_map(Value::as_object)
            .fold((0.0, 0.0), |(generation, throughput), metric| {
                (
                    saturating_float_add(generation, non_negative(metric.get("generationKw"))),
                    saturating_float_add(
                        throughput,
                        non_negative(metric.get("totalItemsPerMinute")),
                    ),
                )
            });
        let swarm = object(base, "dysonSwarm");
        let sphere = object(base, "dysonSphere");
        let dyson_power_kw = saturating_float_add(
            swarm
                .map(|row| non_negative(row.get("generationKw")))
                .unwrap_or(0.0),
            sphere
                .map(|row| non_negative(row.get("generationKw")))
                .unwrap_or(0.0),
        );
        let campaign_completed = safe_count(workspace_completed_task_count(base));
        let campaign_total = safe_count(workspace_task_count());
        let research_completed =
            unique_known_array_count(base, "research", "completedTechIds", |id| {
                self.catalog.technologies.contains_key(id)
            });
        let known_systems = self
            .catalog
            .planets
            .iter()
            .map(|planet| planet.system_id.as_str())
            .collect::<HashSet<_>>();
        let explored_systems =
            unique_known_array_count(base, "exploration", "unlockedSystemIds", |id| {
                known_systems.contains(id)
            });
        let colonized_planets =
            unique_known_array_count(base, "exploration", "colonizedPlanetIds", |id| {
                self.catalog.planets.iter().any(|planet| planet.id == id)
            });

        let value = serde_json::json!({
            "schemaVersion": 1,
            "projectionType": GALAXY_ACCOUNT_WORKSPACE_PROJECTION,
            "source": "native-core",
            "stateVersion": GAME_STATE_VERSION,
            "sessionId": session_id,
            "runId": run_id,
            "revision": self.revision,
            "registryFingerprint": expected_registry_fingerprint,
            "truncated": false,
            "limits": {
                "payloadBytes": MAX_GALAXY_ACCOUNT_WORKSPACE_BYTES,
                "decimalDigits": MAX_DECIMAL_DIGITS,
            },
            "game": {
                "mode": mode,
                "elapsedSeconds": decimal_256(non_negative(base.get("elapsedSeconds"))),
                "difficulty": difficulty,
            },
            "production": {
                "totalProduced": decimal_256(total_produced),
                "universeMatrixProduced": decimal_256(universe_matrix),
                "generationKw": decimal_256(generation_kw),
                "throughputPerMinute": decimal_256(throughput_per_minute),
            },
            "progress": {
                "campaignCompleted": campaign_completed,
                "campaignTotal": campaign_total,
                "researchCompleted": research_completed,
                "exploredSystems": explored_systems,
                "colonizedPlanets": colonized_planets,
                "galacticScore": decimal_256(object(base, "endgame").map(|row| non_negative(row.get("galacticScore"))).unwrap_or(0.0)),
            },
            "dyson": {
                "powerKw": decimal_256(dyson_power_kw),
                "structurePoints": decimal_256(sphere.map(|row| non_negative(row.get("structurePoints"))).unwrap_or(0.0)),
                "rocketsLaunched": decimal_256(sphere.map(|row| non_negative(row.get("totalRocketsLaunched"))).unwrap_or(0.0)),
                "sailsLaunched": decimal_256(swarm.map(|row| non_negative(row.get("totalLaunched"))).unwrap_or(0.0)),
            },
            "cloudCompatibility": {
                "gameStateVersion": GAME_STATE_VERSION,
                "envelopeVersion": ENVELOPE_VERSION,
                "cloudSchemaVersion": CLOUD_SCHEMA_VERSION,
                "exportSupported": true,
                "restoreIntoActiveAuthority": false,
                "importIntoActiveAuthority": false,
                "overwriteActiveAuthority": false,
            },
        });
        if serde_json::to_vec(&value)?.len() > MAX_GALAXY_ACCOUNT_WORKSPACE_BYTES {
            bail!("native galaxy account workspace projection exceeds the byte limit");
        }
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decimal_projection_is_non_negative_bounded_and_saturating() {
        assert_eq!(decimal_256(-1.0), "0");
        assert_eq!(decimal_256(42.9), "42");
        assert_eq!(decimal_256(f64::INFINITY), "0");
        assert_eq!(decimal_256(1e300), "9".repeat(256));
        let saturated = saturating_float_add(f64::MAX, f64::MAX);
        assert_eq!(saturated, f64::MAX);
        assert_eq!(decimal_256(saturated), "9".repeat(256));
    }

    #[test]
    fn galaxy_projection_is_game_only_bounded_and_read_only() {
        let state = crate::simple_factory::tests::fixture_state(&[]);
        let before = state.canonical_sha256().unwrap();
        let projection = state
            .galaxy_account_workspace_projection(
                "authority-1",
                "run-1",
                state.revision,
                "machine-e3",
            )
            .unwrap();
        assert_eq!(projection["projectionType"], "galaxy-account-workspace-v1");
        assert_eq!(projection["sessionId"], "authority-1");
        assert_eq!(projection["runId"], "run-1");
        assert_eq!(projection["revision"], state.revision);
        assert_eq!(projection["registryFingerprint"], "machine-e3");
        assert_eq!(projection["truncated"], false);
        assert_eq!(
            projection["progress"]["campaignTotal"],
            safe_count(workspace_task_count())
        );
        assert_eq!(projection["cloudCompatibility"]["gameStateVersion"], 47);
        assert_eq!(
            projection["cloudCompatibility"]["restoreIntoActiveAuthority"],
            false
        );
        assert!(
            serde_json::to_vec(&projection).unwrap().len() <= MAX_GALAXY_ACCOUNT_WORKSPACE_BYTES
        );
        let encoded = serde_json::to_string(&projection).unwrap();
        for forbidden in [
            "entities",
            "belts",
            "tray",
            "construction",
            "quantumLogisticsNetwork",
            "accounts",
            "cloudSave",
            "inputs",
            "outputs",
        ] {
            assert!(!encoded.contains(forbidden), "leaked {forbidden}");
        }
        assert_eq!(state.canonical_sha256().unwrap(), before);
        assert!(
            state
                .galaxy_account_workspace_projection(
                    "authority-1",
                    "run-1",
                    state.revision + 1,
                    "machine-e3",
                )
                .is_err()
        );
        assert!(
            state
                .galaxy_account_workspace_projection(
                    "authority-1",
                    "run-1",
                    state.revision,
                    "stale",
                )
                .is_err()
        );
    }
}
